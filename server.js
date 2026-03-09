// ========================================
// SERVEUR NODE.JS + SOCKET.IO
// Pour hébergement sur Railway.app
// ========================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const server = http.createServer(app);

// Configuration CORS - IMPORTANT: remplace par ton domaine
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost',
      'https://undeadsurvival.org',
      'https://www.undeadsurvival.org'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// ========================================
// CONFIGURATION BASE DE DONNÉES
// ========================================

// Connexion MySQL vers ton serveur Ex2
let dbPool;

async function initDB() {
  try {
    dbPool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'undead_survival',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    
    console.log('✅ Connexion MySQL établie');
  } catch (error) {
    console.error('❌ Erreur connexion MySQL:', error);
  }
}

initDB();

// ========================================
// STOCKAGE EN MÉMOIRE DES SESSIONS ACTIVES
// ========================================

// Structure: { roomCode: { ... } }
const activeSessions = new Map();

// Structure d'une session
const createSession = (roomCode, creatorId, gmUserId, sessionName = null) => ({
  roomCode,
  sessionName,
  creatorId,
  gmUserId,
  participants: [],
  state: {
    scene: null,
    music: null,
    diceHistory: [],
    chatHistory: [],
    tokens: [],
    turnOrder: [],
    currentTurn: 0
  },
  createdAt: Date.now(),
  lastActivity: Date.now()
});

// ========================================
// ENDPOINTS REST API
// ========================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeSessions: activeSessions.size,
    uptime: process.uptime()
  });
});

// Obtenir l'état d'une session
app.get('/session/:roomCode', async (req, res) => {
  const { roomCode } = req.params;
  const session = activeSessions.get(roomCode);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({ session });
});

// ========================================
// SOCKET.IO - GESTION TEMPS RÉEL
// ========================================

io.on('connection', (socket) => {
  console.log(`✅ Client connecté: ${socket.id}`);
  
  // ===== CRÉER UNE PARTIE =====
  socket.on('create-session', async ({ userId, userName, isGM, sessionName }) => {
    try {
      // Générer un code room unique
      const roomCode = generateRoomCode();
      
      // Créer la session en mémoire
      const session = createSession(roomCode, userId, isGM ? userId : null, sessionName || null);
      
      // Ajouter le créateur comme participant
      session.participants.push({
        userId,
        userName,
        socketId: socket.id,
        isGM: isGM || false,
        joinedAt: Date.now()
      });
      
      activeSessions.set(roomCode, session);
      
      // Rejoindre la room Socket.io
      socket.join(roomCode);
      socket.currentRoom = roomCode;
      
      // Sauvegarder en BDD (asynchrone, pas bloquant)
      saveSessionToDB(session).catch(err => 
        console.error('Erreur sauvegarde BDD:', err)
      );
      
      // Confirmer au client
      socket.emit('session-created', { 
        roomCode, 
        session: sanitizeSession(session, userId)
      });
      
      console.log(`🎲 Session créée: ${roomCode} par ${userName}`);
      
    } catch (error) {
      console.error('Erreur création session:', error);
      socket.emit('error', { message: 'Failed to create session' });
    }
  });
  
  // ===== REJOINDRE UNE PARTIE =====
  socket.on('join-session', async ({ roomCode, userId, userName, characterId, isGM }) => {
    try {
      let session = activeSessions.get(roomCode);
      
      // Si la session n'est pas en mémoire, la charger depuis la BDD
      if (!session) {
        console.log(`🔍 Session ${roomCode} pas en mémoire, chargement depuis BDD...`);
        
        if (!dbPool) {
          return socket.emit('error', { message: 'Database not available' });
        }
        
        // Récupérer la session depuis la BDD
        const [rows] = await dbPool.execute(
          `SELECT id, room_code, session_name, creator_id, gm_user_id, state_data, created_at 
           FROM game_sessions 
           WHERE room_code = ? AND status = 'active'`,
          [roomCode]
        );
        
        if (rows.length === 0) {
          return socket.emit('error', { message: 'Session not found' });
        }
        
        const dbSession = rows[0];
        
        // Récupérer les participants
        const [participants] = await dbPool.execute(
		  `SELECT 
			gp.user_id, 
			u.display_name as user_name, 
			u.avatar_url,
			gp.role, 
			gp.character_id,
			c.avatar_url as character_avatar_url,
			CONCAT(c.prenom, ' ', c.nom) as character_name
		   FROM game_participants gp
		   JOIN users u ON gp.user_id = u.id
		   LEFT JOIN characters c ON gp.character_id = c.id
		   WHERE gp.session_id = ? AND gp.left_at IS NULL`,
		  [dbSession.id]
		);
        
        // Charger l'état depuis la BDD ou créer un état vide
        let state = dbSession.state_data ? JSON.parse(dbSession.state_data) : {
          scene: null,
          music: null,
          diceHistory: [],
          chatHistory: [],
          tokens: [],
          turnOrder: [],
          currentTurn: 0
        };
        
        // Créer la session en mémoire
        session = {
          roomCode: dbSession.room_code,
          sessionName: dbSession.session_name,
          creatorId: dbSession.creator_id,
          gmUserId: dbSession.gm_user_id,
          participants: participants.map(p => ({
            userId:               p.user_id,
            userName:             p.user_name,
            socketId:             null,
            isGM:                 p.role === 'gm',
            characterId:          p.character_id          || null,
            characterName:        p.character_name        || null,
            character_avatar_url: p.character_avatar_url  || null,
            avatar_url:           p.avatar_url            || null,
            joinedAt:             Date.now()
          })),
          state,
          createdAt: new Date(dbSession.created_at).getTime(),
          lastActivity: Date.now()
        };
        
        activeSessions.set(roomCode, session);
        console.log(`✅ Session ${roomCode} chargée depuis BDD`);
      }
      
      // Vérifier si l'utilisateur est déjà dans la session
      const existingParticipant = session.participants.find(p => p.userId === userId);
      
      if (existingParticipant) {
        // RECONNEXION : Mettre à jour uniquement le socketId
        existingParticipant.socketId = socket.id;
        // Mettre à jour le characterId si fourni
        if (characterId) {
          existingParticipant.characterId = characterId;
        }
        console.log(`🔄 ${userName} s'est reconnecté à ${roomCode}`);
      } else {
        // Déterminer si c'est le MJ (via flag OU si c'est le gm_user_id)
        const isUserGM = isGM || userId === session.gmUserId;
        
        // Refuser l'accès spectateur : joueur sans personnage = rejeté
        if (!isUserGM && !characterId) {
          socket.emit('join-error', {
            code:    'NO_CHARACTER',
            message: 'Vous devez sélectionner un personnage pour rejoindre cette partie.',
          });
          return;
        }

        // Récupérer les avatars depuis la BDD pour ce participant
        let character_avatar_url = null;
        let avatar_url = null;
        let characterName = null;
        if (dbPool) {
          try {
            const [avatarRows] = await dbPool.execute(
              `SELECT u.avatar_url,
                      c.avatar_url             AS character_avatar_url,
                      CONCAT(c.prenom, ' ', c.nom) AS character_name
               FROM users u
               LEFT JOIN characters c ON c.id = ? AND c.user_id = u.id
               WHERE u.id = ?
               LIMIT 1`,
              [characterId || null, userId]
            );
            if (avatarRows.length > 0) {
              avatar_url           = avatarRows[0].avatar_url           || null;
              character_avatar_url = avatarRows[0].character_avatar_url || null;
              characterName        = avatarRows[0].character_name       || null;
            }
          } catch (e) { /* non bloquant */ }
        }

        session.participants.push({
          userId,
          userName,
          socketId: socket.id,
          isGM: isUserGM,
          characterId: characterId || null,
          avatar_url,
          character_avatar_url,
          characterName,
          joinedAt: Date.now()
        });
        
        console.log(`➕ ${userName} ajouté à ${roomCode} ${isUserGM ? '(MJ)' : '(Joueur)'}`);
      }
      
      // Si sessionName manquant (session créée en mémoire avant ce fix), le charger depuis BDD
      if (!session.sessionName && dbPool) {
        try {
          const [nameRows] = await dbPool.execute(
            'SELECT session_name FROM game_sessions WHERE room_code = ? LIMIT 1',
            [roomCode]
          );
          if (nameRows.length > 0) session.sessionName = nameRows[0].session_name || null;
        } catch (e) { /* non bloquant */ }
      }

      // Rejoindre la room
      socket.join(roomCode);
      socket.currentRoom = roomCode;
      session.lastActivity = Date.now();
      
      // Envoyer l'état complet au nouveau joueur
      socket.emit('session-joined', { 
        session: sanitizeSession(session, userId)
      });
      
      // Notifier les autres participants
      const joinedParticipant = session.participants.find(p => p.userId === userId);
      socket.to(roomCode).emit('participant-joined', {
        userId,
        userName,
        isGM:                 joinedParticipant?.isGM                 || false,
        characterId:          joinedParticipant?.characterId          || null,
        character_avatar_url: joinedParticipant?.character_avatar_url || null,
        avatar_url:           joinedParticipant?.avatar_url           || null,
        characterName:        joinedParticipant?.characterName        || null,
        timestamp:            Date.now()
      });
      
      // Mettre à jour la BDD
      updateSessionParticipants(roomCode, session.participants).catch(err =>
        console.error('Erreur MAJ participants:', err)
      );
      
      console.log(`👤 ${userName} a rejoint ${roomCode}`);
      
    } catch (error) {
      console.error('Erreur rejoindre session:', error);
      socket.emit('error', { message: 'Failed to join session: ' + error.message });
    }
  });
  
  // ===== LANCER UN DÉ =====
  socket.on('roll-dice', ({ roomCode, userId, userName, formula, result }) => {
    const session = activeSessions.get(roomCode);
    if (!session) return;
    
    const roll = {
      id: Date.now(),
      userId,
      userName,
      formula,
      result,
      timestamp: Date.now()
    };
    
    session.state.diceHistory.push(roll);
    session.lastActivity = Date.now();
    
    // Limiter l'historique à 50 jets
    if (session.state.diceHistory.length > 50) {
      session.state.diceHistory.shift();
    }
    
    // Broadcast à tous dans la room
    io.to(roomCode).emit('dice-rolled', roll);
    
    console.log(`🎲 ${userName} lance ${formula} = ${result}`);
  });
  
  // ===== ENVOYER UN MESSAGE CHAT =====
  socket.on('send-message', ({ roomCode, userId, userName, message }) => {
    const session = activeSessions.get(roomCode);
    if (!session) return;
    
    const chatMessage = {
      id: Date.now(),
      userId,
      userName,
      message,
      timestamp: Date.now()
    };
    
    session.state.chatHistory.push(chatMessage);
    session.lastActivity = Date.now();
    
    // Limiter l'historique à 100 messages
    if (session.state.chatHistory.length > 100) {
      session.state.chatHistory.shift();
    }
    
    // Broadcast
    io.to(roomCode).emit('message-received', chatMessage);
  });
  
  // ===== CHANGER LA SCÈNE (MJ ONLY) =====
  socket.on('change-scene', ({ roomCode, userId, sceneUrl }) => {
    const session = activeSessions.get(roomCode);
    if (!session) return;
    
    // Vérifier que l'utilisateur est le MJ
    const participant = session.participants.find(p => p.userId === userId);
    if (!participant || !participant.isGM) {
      return socket.emit('error', { message: 'Only GM can change scene' });
    }
    
    session.state.scene = sceneUrl;
    session.lastActivity = Date.now();
    
    // Broadcast à tous
    io.to(roomCode).emit('scene-changed', { sceneUrl, timestamp: Date.now() });
    
    console.log(`🖼️ Scène changée dans ${roomCode}: ${sceneUrl}`);
  });
  
  // ===== CHANGER LA MUSIQUE (MJ ONLY) =====
  socket.on('change-music', ({ roomCode, userId, musicUrl }) => {
    const session = activeSessions.get(roomCode);
    if (!session) return;
    
    const participant = session.participants.find(p => p.userId === userId);
    if (!participant || !participant.isGM) {
      return socket.emit('error', { message: 'Only GM can change music' });
    }
    
    session.state.music = musicUrl;
    session.lastActivity = Date.now();
    
    io.to(roomCode).emit('music-changed', { musicUrl, timestamp: Date.now() });
    
    console.log(`🎵 Musique changée dans ${roomCode}`);
  });
  
  // ===== DÉCONNEXION =====
  socket.on('disconnect', () => {
    console.log(`❌ Client déconnecté: ${socket.id}`);
    
    // Trouver la session de ce socket
    if (socket.currentRoom) {
      const session = activeSessions.get(socket.currentRoom);
      if (session) {
        const participant = session.participants.find(p => p.socketId === socket.id);
        if (participant) {
          // Notifier les autres
          socket.to(socket.currentRoom).emit('participant-left', {
            userId: participant.userId,
            userName: participant.userName,
            timestamp: Date.now()
          });
        }
      }
    }
  });
  
  // ===== QUITTER UNE PARTIE =====
  socket.on('leave-session', ({ roomCode, userId }) => {
    const session = activeSessions.get(roomCode);
    if (!session) return;
    
    // Retirer le participant
    const participantIndex = session.participants.findIndex(p => p.userId === userId);
    if (participantIndex !== -1) {
      const participant = session.participants[participantIndex];
      session.participants.splice(participantIndex, 1);
      
      socket.leave(roomCode);
      socket.currentRoom = null;
      
      // Notifier les autres
      socket.to(roomCode).emit('participant-left', {
        userId: participant.userId,
        userName: participant.userName,
        timestamp: Date.now()
      });
      
      // Si plus personne, supprimer la session après 5 minutes
      if (session.participants.length === 0) {
        setTimeout(() => {
          const currentSession = activeSessions.get(roomCode);
          if (currentSession && currentSession.participants.length === 0) {
            activeSessions.delete(roomCode);
            console.log(`🗑️ Session ${roomCode} supprimée (inactivité)`);
          }
        }, 5 * 60 * 1000);
      }
      
      console.log(`👋 ${participant.userName} a quitté ${roomCode}`);
    }
  })

  // ── kick-player (GM seulement) ──────────────────────────────────────────────
  socket.on('kick-player', async ({ roomCode, targetUserId, reason }) => {
    const session = activeSessions.get(roomCode);
    if (!session) return;

    const requester = session.participants.find(p => p.socketId === socket.id);
    if (!requester?.isGM) return;

    const target = session.participants.find(p => p.userId === targetUserId);
    if (!target) return;

    // Retirer de la session en mémoire
    session.participants = session.participants.filter(p => p.userId !== targetUserId);
    session.lastActivity = Date.now();

    // Notifier le joueur via son socketId personnel (chaque socket = sa propre room)
    // Fonctionne même si on n'a pas le socket object directement
    if (target.socketId) {
      // Envoyer kicked à ce socket spécifiquement
      io.to(target.socketId).emit('kicked', { reason: reason || 'Vous avez été expulsé par le MJ.' });
      
      // Forcer la sortie de la room
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) {
        targetSocket.leave(roomCode);
        targetSocket.currentRoom = null;
      }
    }

    // Marquer left_at en BDD
    if (dbPool) {
      try {
        await dbPool.execute(
          `UPDATE game_participants gp
           JOIN game_sessions gs ON gp.session_id = gs.id
           SET gp.left_at = NOW()
           WHERE gs.room_code = ? AND gp.user_id = ? AND gp.left_at IS NULL`,
          [roomCode, targetUserId]
        );
      } catch (e) { console.error('kick DB error:', e); }
    }

    // Informer toute la room
    io.to(roomCode).emit('participant-left', {
      userId:    targetUserId,
      userName:  target.userName,
      kicked:    true,
      timestamp: Date.now(),
    });

    console.log(`Expulsion: ${target.userName} de ${roomCode} par ${requester.userName}`);
  });

  // ── change-session-status (GM seulement) ────────────────────────────────────
  socket.on('change-session-status', async ({ roomCode, status }) => {
    const VALID_STATUSES = ['active', 'paused', 'ended'];
    if (!VALID_STATUSES.includes(status)) return;

    const session = activeSessions.get(roomCode);
    if (!session) return;

    const requester = session.participants.find(p => p.socketId === socket.id);
    if (!requester?.isGM) return;

    session.status       = status;
    session.lastActivity = Date.now();

    // Persister en BDD
    if (dbPool) {
      try {
        await dbPool.execute(
          'UPDATE game_sessions SET status = ?, last_activity = NOW() WHERE room_code = ?',
          [status, roomCode]
        );
      } catch (e) { console.error('status DB error:', e); }
    }

    // Broadcaster à toute la room
    io.to(roomCode).emit('session-status-changed', {
      status,
      changedBy: requester.userName,
      timestamp: Date.now(),
    });

    console.log(`Session ${roomCode} => ${status} par ${requester.userName}`);
  });
;
});

// ========================================
// FONCTIONS UTILITAIRES
// ========================================

// Générer un code de room unique (6 caractères)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  
  // Vérifier l'unicité
  if (activeSessions.has(code)) {
    return generateRoomCode();
  }
  
  return code;
}

// Nettoyer les données sensibles avant envoi
function sanitizeSession(session, userId) {
  return {
    roomCode:    session.roomCode,
    sessionName: session.sessionName || null,
    participants: session.participants.map(p => ({
      userId:               p.userId,
      userName:             p.userName,
      isGM:                 p.isGM,
      characterId:          p.characterId          || null,
      characterName:        p.characterName        || null,
      character_avatar_url: p.character_avatar_url || null,
      avatar_url:           p.avatar_url           || null,
      joinedAt:             p.joinedAt
    })),
    state:     session.state,
    isGM:      session.participants.find(p => p.userId === userId)?.isGM || false,
    createdAt: session.createdAt
  };
}

// ========================================
// SAUVEGARDE EN BDD
// ========================================

async function saveSessionToDB(session) {
  if (!dbPool) return;
  
  try {
    await dbPool.execute(
      `INSERT INTO game_sessions (room_code, session_name, creator_id, gm_user_id, created_at, last_activity, status)
       VALUES (?, ?, ?, ?, NOW(), NOW(), 'active')`,
      [session.roomCode, session.sessionName || null, session.creatorId, session.gmUserId]
    );
    
    console.log(`💾 Session ${session.roomCode} sauvegardée en BDD`);
  } catch (error) {
    console.error('Erreur sauvegarde session:', error);
  }
}

async function updateSessionParticipants(roomCode, participants) {
  if (!dbPool) return;
  
  try {
    for (const p of participants) {
      // UPSERT : met à jour si le participant existe déjà, insère sinon
      // Préserve joined_at et left_at existants
      await dbPool.execute(
        `INSERT INTO game_participants (session_id, user_id, role, character_id, joined_at)
         VALUES ((SELECT id FROM game_sessions WHERE room_code = ?), ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           role         = VALUES(role),
           character_id = VALUES(character_id),
           left_at      = NULL`,
        [roomCode, p.userId, p.isGM ? 'gm' : 'player', p.characterId || null]
      );
    }
    
    // Mettre à jour last_activity
    await dbPool.execute(
      'UPDATE game_sessions SET last_activity = NOW() WHERE room_code = ?',
      [roomCode]
    );
    
  } catch (error) {
    console.error('Erreur MAJ participants:', error);
  }
}

// Sauvegarder périodiquement toutes les sessions actives
setInterval(() => {
  activeSessions.forEach(async (session) => {
    try {
      await dbPool.execute(
        `UPDATE game_sessions 
         SET last_activity = NOW(), 
             state_data = ?
         WHERE room_code = ?`,
        [JSON.stringify(session.state), session.roomCode]
      );
    } catch (error) {
      console.error(`Erreur sauvegarde périodique ${session.roomCode}:`, error);
    }
  });
}, 2 * 60 * 1000); // Toutes les 2 minutes

// ========================================
// NETTOYAGE AUTOMATIQUE DES SESSIONS
// Logique entièrement dans Node.js
// - Sessions "ended" → purgées de la mémoire + participants left_at mis à jour
// - Sessions inactives depuis > 2h → marquées "ended" en BDD + purgées
// - Sessions "paused" depuis > 24h → marquées "ended"
// ========================================
const CLEANUP_INTERVAL    = 15 * 60 * 1000;      // toutes les 15 minutes
const INACTIVE_TIMEOUT_MS = 2  * 60 * 60 * 1000; // 2h sans activité
const PAUSED_TIMEOUT_MS   = 24 * 60 * 60 * 1000; // 24h en pause

setInterval(async () => {
  if (!dbPool) return;

  const now = Date.now();
  let purged = 0;

  // ── 1. Purger les sessions en mémoire (ended / inactives / pause longue) ──
  for (const [roomCode, session] of activeSessions.entries()) {
    const inactiveSince = now - (session.lastActivity || 0);
    const isEnded       = session.status === 'ended';
    const isInactive    = inactiveSince > INACTIVE_TIMEOUT_MS;
    const isPausedLong  = session.status === 'paused' && inactiveSince > PAUSED_TIMEOUT_MS;

    if (isEnded || isInactive || isPausedLong) {
      try {
        const reason = isEnded
          ? 'La session a été terminée.'
          : 'Session expirée par inactivité.';

        // Notifier les clients encore connectés
        const socketsInRoom = await io.in(roomCode).fetchSockets();
        if (socketsInRoom.length > 0) {
          io.to(roomCode).emit('session-ended', { reason });
        }

        // Marquer la session ended en BDD si elle ne l'est pas déjà
        if (!isEnded) {
          await dbPool.execute(
            `UPDATE game_sessions
             SET status = 'ended', last_activity = NOW()
             WHERE room_code = ? AND status != 'ended'`,
            [roomCode]
          );
        }

        // Marquer tous les participants actifs comme partis
        await dbPool.execute(
          `UPDATE game_participants gp
           JOIN game_sessions gs ON gp.session_id = gs.id
           SET gp.left_at = NOW()
           WHERE gs.room_code = ? AND gp.left_at IS NULL`,
          [roomCode]
        );

        activeSessions.delete(roomCode);
        purged++;
        console.log(`🗑️  Session ${roomCode} purgée (${isEnded ? 'ended' : isInactive ? 'inactive' : 'pause longue'})`);

      } catch (e) {
        console.error(`Erreur purge session ${roomCode}:`, e);
      }
    }
  }

  // ── 2. Nettoyer aussi la BDD pour les vieilles sessions hors mémoire ──────
  // (sessions créées mais jamais rejointes, ou serveur redémarré)
  try {
    // Sessions actives/paused sans activité depuis > 2h
    await dbPool.execute(
      `UPDATE game_sessions
       SET status = 'ended'
       WHERE status IN ('active', 'paused')
         AND last_activity < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
    );

    // Fermer les participants orphelins de sessions ended
    await dbPool.execute(
      `UPDATE game_participants gp
       JOIN game_sessions gs ON gp.session_id = gs.id
       SET gp.left_at = NOW()
       WHERE gs.status = 'ended'
         AND gp.left_at IS NULL`
    );

  } catch (e) {
    console.error('Erreur nettoyage BDD:', e);
  }

  if (purged > 0) {
    console.log(`🧹 Cleanup: ${purged} session(s) purgée(s)`);
  }

}, CLEANUP_INTERVAL);

// ========================================
// DÉMARRAGE SERVEUR
// ========================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   🎲 UNDEAD SURVIVAL GAME SERVER      ║
  ║   Port: ${PORT}                           ║
  ║   Status: ONLINE                      ║
  ╚════════════════════════════════════════╝
  `);
});