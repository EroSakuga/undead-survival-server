#!/bin/bash

# ========================================
# Script de test local du serveur Socket.io
# ========================================

echo "🎲 Undead Survival - Test serveur local"
echo "========================================"
echo ""

# Vérifier si Node.js est installé
if ! command -v node &> /dev/null; then
    echo "❌ Node.js n'est pas installé"
    echo "   Télécharge-le depuis https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo ""

# Se déplacer dans le dossier server
cd "$(dirname "$0")"

# Vérifier si node_modules existe
if [ ! -d "node_modules" ]; then
    echo "📦 Installation des dépendances..."
    npm install
    echo ""
fi

# Créer un fichier .env si n'existe pas
if [ ! -f ".env" ]; then
    echo "📝 Création du fichier .env..."
    cat > .env << EOF
# Configuration locale de test
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=undead_survival
PORT=3001
EOF
    echo "⚠️  Modifie le fichier .env avec tes vraies infos de BDD"
    echo ""
fi

# Démarrer le serveur
echo "🚀 Démarrage du serveur sur http://localhost:3001"
echo "   Appuie sur Ctrl+C pour arrêter"
echo ""
echo "📊 Health check : http://localhost:3001/health"
echo ""

npm start
