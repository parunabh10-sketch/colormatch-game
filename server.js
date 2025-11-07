const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Game rooms storage
const rooms = new Map();
const players = new Map();

// Card properties
const colors = ['red', 'blue', 'green', 'yellow'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', '+2'];

// Generate room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Create and shuffle deck
function createDeck() {
    let deck = [];

    for (let color of colors) {
        deck.push({ color, value: '0', type: 'number' });

        for (let value of values.slice(1)) {
            deck.push({ color, value, type: isNaN(value) ? 'action' : 'number' });
            deck.push({ color, value, type: isNaN(value) ? 'action' : 'number' });
        }
    }

    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'wild', value: 'wild', type: 'wild' });
        deck.push({ color: 'wild', value: 'wild+4', type: 'wild' });
    }

    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
}

// Initialize game
function initializeGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const deck = createDeck();

    const player1Hand = [];
    const player2Hand = [];

    for (let i = 0; i < 7; i++) {
        player1Hand.push(deck.pop());
        player2Hand.push(deck.pop());
    }

    let firstCard;
    do {
        firstCard = deck.pop();
    } while (firstCard.type === 'wild' || firstCard.type === 'action');

    room.gameState = {
        deck: deck,
        discardPile: [firstCard],
        hands: {
            [room.players[0].id]: player1Hand,
            [room.players[1].id]: player2Hand
        },
        currentPlayer: room.players[0].id,
        currentColor: firstCard.color,
        currentValue: firstCard.value,
        hasDrawn: false,
        skipNext: false,
        direction: 1
    };

    room.started = true;

    return room.gameState;
}

// Socket.io handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    const playerName = socket.handshake.query.playerName || 'Player';
    players.set(socket.id, {
        id: socket.id,
        name: playerName,
        roomCode: null
    });

    socket.on('createRoom', () => {
        let roomCode;
        do {
            roomCode = generateRoomCode();
        } while (rooms.has(roomCode));

        const room = {
            code: roomCode,
            host: socket.id,
            players: [{
                id: socket.id,
                name: playerName,
                ready: true
            }],
            started: false,
            gameState: null
        };

        rooms.set(roomCode, room);
        players.get(socket.id).roomCode = roomCode;

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);

        console.log(`Room ${roomCode} created by ${playerName}`);
    });

    socket.on('joinRoom', (roomCode) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('error', 'Room is full');
            return;
        }

        if (room.started) {
            socket.emit('error', 'Game already started');
            return;
        }

        room.players.push({
            id: socket.id,
            name: playerName,
            ready: true
        });

        players.get(socket.id).roomCode = roomCode;

        socket.join(roomCode);
        socket.emit('roomJoined', {
            roomCode,
            players: room.players
        });

        io.to(room.host).emit('playerJoined', {
            players: room.players
        });

        console.log(`${playerName} joined room ${roomCode}`);
    });

    socket.on('startGame', (roomCode) => {
        console.log(`Start game request for room ${roomCode}`);
        const room = rooms.get(roomCode);

        if (!room || room.host !== socket.id) {
            socket.emit('error', 'Cannot start game');
            return;
        }

        if (room.players.length !== 2) {
            socket.emit('error', 'Need exactly 2 players');
            return;
        }

        const gameState = initializeGame(roomCode);

        room.players.forEach(player => {
            const playerHand = gameState.hands[player.id];
            const opponentId = room.players.find(p => p.id !== player.id).id;
            const opponentHandCount = gameState.hands[opponentId].length;

            io.to(player.id).emit('gameStarted', {
                hand: playerHand,
                opponentCardCount: opponentHandCount,
                discardTop: gameState.discardPile[gameState.discardPile.length - 1],
                currentPlayer: gameState.currentPlayer,
                currentColor: gameState.currentColor,
                currentValue: gameState.currentValue,
                isMyTurn: gameState.currentPlayer === player.id,
                player1Name: room.players[0].name,
                player2Name: room.players[1].name,
                myPosition: player.id === room.players[0].id ? 'player1' : 'player2'
            });
        });

        console.log(`Game started in room ${roomCode}`);
    });

    socket.on('playCard', (data) => {
        const { roomCode, cardIndex, selectedColor } = data;
        const room = rooms.get(roomCode);

        if (!room || !room.gameState) {
            socket.emit('error', 'Game not found');
            return;
        }

        const gameState = room.gameState;

        if (gameState.currentPlayer !== socket.id) {
            socket.emit('error', 'Not your turn');
            return;
        }

        const hand = gameState.hands[socket.id];
        const card = hand[cardIndex];

        if (!card) {
            socket.emit('error', 'Invalid card');
            return;
        }

        if (card.type !== 'wild' && 
            card.color !== gameState.currentColor && 
            card.value !== gameState.currentValue) {
            socket.emit('error', 'Cannot play that card');
            return;
        }

        hand.splice(cardIndex, 1);
        gameState.discardPile.push(card);

        if (card.type === 'wild') {
            gameState.currentColor = selectedColor || 'red';
        } else {
            gameState.currentColor = card.color;
        }
        gameState.currentValue = card.value;

        let skipTurn = false;
        const opponentId = room.players.find(p => p.id !== socket.id).id;

        if (card.value === 'skip' || card.value === 'reverse') {
            skipTurn = true;
        } else if (card.value === '+2') {
            for (let i = 0; i < 2; i++) {
                if (gameState.deck.length > 0) {
                    gameState.hands[opponentId].push(gameState.deck.pop());
                }
            }
            skipTurn = true;
        } else if (card.value === 'wild+4') {
            for (let i = 0; i < 4; i++) {
                if (gameState.deck.length > 0) {
                    gameState.hands[opponentId].push(gameState.deck.pop());
                }
            }
            skipTurn = true;
        }

        if (hand.length === 0) {
            const winner = players.get(socket.id).name;
            io.to(roomCode).emit('gameOver', { winner });

            rooms.delete(roomCode);
            room.players.forEach(p => {
                players.get(p.id).roomCode = null;
            });
            return;
        }

        if (!skipTurn) {
            gameState.currentPlayer = opponentId;
        }
        gameState.hasDrawn = false;

        room.players.forEach(player => {
            const playerHand = gameState.hands[player.id];
            const oppId = room.players.find(p => p.id !== player.id).id;
            const oppHandCount = gameState.hands[oppId].length;

            io.to(player.id).emit('gameUpdate', {
                hand: playerHand,
                opponentCardCount: oppHandCount,
                discardTop: gameState.discardPile[gameState.discardPile.length - 1],
                currentPlayer: gameState.currentPlayer,
                currentColor: gameState.currentColor,
                currentValue: gameState.currentValue,
                isMyTurn: gameState.currentPlayer === player.id,
                lastAction: `${players.get(socket.id).name} played a card`
            });
        });
    });

    socket.on('drawCard', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room || !room.gameState) {
            socket.emit('error', 'Game not found');
            return;
        }

        const gameState = room.gameState;

        if (gameState.currentPlayer !== socket.id) {
            socket.emit('error', 'Not your turn');
            return;
        }

        if (gameState.hasDrawn) {
            socket.emit('error', 'Already drawn this turn');
            return;
        }

        if (gameState.deck.length === 0) {
            const topCard = gameState.discardPile.pop();
            gameState.deck = gameState.discardPile;
            gameState.discardPile = [topCard];

            for (let i = gameState.deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
            }
        }

        if (gameState.deck.length > 0) {
            const drawnCard = gameState.deck.pop();
            gameState.hands[socket.id].push(drawnCard);
            gameState.hasDrawn = true;

            room.players.forEach(player => {
                const playerHand = gameState.hands[player.id];
                const oppId = room.players.find(p => p.id !== player.id).id;
                const oppHandCount = gameState.hands[oppId].length;

                io.to(player.id).emit('gameUpdate', {
                    hand: playerHand,
                    opponentCardCount: oppHandCount,
                    discardTop: gameState.discardPile[gameState.discardPile.length - 1],
                    currentPlayer: gameState.currentPlayer,
                    currentColor: gameState.currentColor,
                    currentValue: gameState.currentValue,
                    isMyTurn: gameState.currentPlayer === player.id,
                    lastAction: `${players.get(socket.id).name} drew a card`,
                    canEndTurn: true
                });
            });
        }
    });

    socket.on('endTurn', (roomCode) => {
        const room = rooms.get(roomCode);

        if (!room || !room.gameState) return;

        const gameState = room.gameState;

        if (gameState.currentPlayer !== socket.id) return;
        if (!gameState.hasDrawn) return;

        const opponentId = room.players.find(p => p.id !== socket.id).id;
        gameState.currentPlayer = opponentId;
        gameState.hasDrawn = false;

        room.players.forEach(player => {
            const playerHand = gameState.hands[player.id];
            const oppId = room.players.find(p => p.id !== player.id).id;
            const oppHandCount = gameState.hands[oppId].length;

            io.to(player.id).emit('gameUpdate', {
                hand: playerHand,
                opponentCardCount: oppHandCount,
                discardTop: gameState.discardPile[gameState.discardPile.length - 1],
                currentPlayer: gameState.currentPlayer,
                currentColor: gameState.currentColor,
                currentValue: gameState.currentValue,
                isMyTurn: gameState.currentPlayer === player.id,
                lastAction: 'Turn ended'
            });
        });
    });

    socket.on('disconnect', () => {
        const player = players.get(socket.id);

        if (player && player.roomCode) {
            const room = rooms.get(player.roomCode);

            if (room) {
                room.players.forEach(p => {
                    if (p.id !== socket.id) {
                        io.to(p.id).emit('playerDisconnected', {
                            message: `${player.name} disconnected`
                        });
                    }
                });

                rooms.delete(player.roomCode);
            }
        }

        players.delete(socket.id);
        console.log('Player disconnected:', socket.id);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 ColorMatch Server running on port ${PORT}`);
    console.log(`🌐 Your game is live!`);
});