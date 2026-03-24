const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const ROWS = 9;
const COLS = 9;
const PRIORITY_PATTERNS = [[1, 2, 3], [3, 1, 2], [2, 3, 1]];

// ★ 部屋（モード）ごとに独立したゲーム状態を作るファクトリー関数
function createGameState() {
    return {
        players: {}, // { socketId: { num, name } }
        availableSlots: [1, 2, 3],
        board: Array.from({length: ROWS}, () => Array(COLS).fill(0)),
        currentTurn: 1,
        submittedMoves: {},
        hasOfferedDraw: { 1: false, 2: false, 3: false },
        activeDrawOffer: null,
        lastMoves: [] // ★追加: 落下アニメーション用に「直前のターンで誰がどこに落としたか」を記憶
    };
}

// 2つのモードの部屋を用意
const games = {
    normal: createGameState(),
    blind: createGameState()
};

// どのソケットがどのモードにいるかを記憶
let socketModes = {}; 

function getPlayerNames(mode) {
    let names = { 1: "待機中", 2: "待機中", 3: "待機中" };
    const game = games[mode];
    for (let sid in game.players) {
        names[game.players[sid].num] = game.players[sid].name;
    }
    return names;
}

io.on('connection', (socket) => {
    
    // --- ログイン・入室 ---
    socket.on('joinGame', (data) => {
        const mode = data.mode;
        const game = games[mode];
        
        socketModes[socket.id] = mode;
        socket.join(mode); // Socket.ioのルーム機能で振り分け

        if (game.availableSlots.length > 0) {
            const playerNum = game.availableSlots.shift();
            game.players[socket.id] = { num: playerNum, name: data.name };
            
            socket.emit('assignPlayer', playerNum);
            
            // その部屋の人たちだけに送信
            io.to(mode).emit('updateNames', getPlayerNames(mode));
            socket.emit('updateState', { 
                board: game.board, turn: game.currentTurn, 
                readyPlayers: Object.keys(game.submittedMoves), 
                hasOfferedDraw: game.hasOfferedDraw,
                lastMoves: [] 
            });
        } else {
            socket.emit('spectator');
            socket.emit('updateNames', getPlayerNames(mode));
            socket.emit('updateState', { board: game.board, turn: game.currentTurn, readyPlayers: Object.keys(game.submittedMoves), hasOfferedDraw: game.hasOfferedDraw, lastMoves: [] });
        }
    });

    // --- アクションの受信 ---
    socket.on('submitMove', (col) => {
        const mode = socketModes[socket.id];
        if(!mode) return;
        const game = games[mode];
        
        if (!game.players[socket.id]) return;
        const pNum = game.players[socket.id].num;
        if (game.submittedMoves[pNum] !== undefined) return; 

        game.submittedMoves[pNum] = col;
        io.to(mode).emit('playerReady', Object.keys(game.submittedMoves));

        if (Object.keys(game.submittedMoves).length === 3) {
            processTurn(mode);
        }
    });

    // --- 流局処理 ---
    socket.on('offerDraw', () => {
        const mode = socketModes[socket.id];
        if(!mode) return;
        const game = games[mode];

        if (!game.players[socket.id]) return;
        const pNum = game.players[socket.id].num;
        if (game.hasOfferedDraw[pNum] || game.activeDrawOffer) return;

        game.hasOfferedDraw[pNum] = true;
        game.activeDrawOffer = { initiator: pNum, accepted: [] };
        io.to(mode).emit('drawOffered', { initiator: pNum });
    });

    socket.on('respondDraw', (isAccepted) => {
        const mode = socketModes[socket.id];
        if(!mode) return;
        const game = games[mode];

        if (!game.players[socket.id] || !game.activeDrawOffer) return;
        const pNum = game.players[socket.id].num;
        if (game.activeDrawOffer.initiator === pNum || game.activeDrawOffer.accepted.includes(pNum)) return;

        if (!isAccepted) {
            game.activeDrawOffer = null;
            io.to(mode).emit('drawRejected', { rejector: pNum, hasOfferedDraw: game.hasOfferedDraw });
        } else {
            game.activeDrawOffer.accepted.push(pNum);
            if (game.activeDrawOffer.accepted.length === 2) {
                game.activeDrawOffer = null;
                io.to(mode).emit('gameOver', { board: game.board, winner: 0, reason: 'draw_agreed' });
            } else {
                io.to(mode).emit('drawAcceptedBy', { accepter: pNum });
            }
        }
    });

    // --- リセット・シャッフル ---
    socket.on('requestReset', (shuffleMode) => {
        const mode = socketModes[socket.id];
        if(!mode) return;
        const game = games[mode];

        game.board = Array.from({length: ROWS}, () => Array(COLS).fill(0));
        game.currentTurn = 1;
        game.submittedMoves = {};
        game.hasOfferedDraw = { 1: false, 2: false, 3: false };
        game.activeDrawOffer = null;
        game.lastMoves = [];

        if (shuffleMode === 'shuffle') {
            let activeSockets = Object.keys(game.players);
            let currentNums = activeSockets.map(sid => game.players[sid].num);
            
            for (let i = currentNums.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [currentNums[i], currentNums[j]] = [currentNums[j], currentNums[i]];
            }
            
            activeSockets.forEach((sid, index) => {
                game.players[sid].num = currentNums[index];
                io.to(sid).emit('assignPlayer', game.players[sid].num);
            });
            io.to(mode).emit('updateNames', getPlayerNames(mode));
        }

        io.to(mode).emit('updateState', { board: game.board, turn: game.currentTurn, readyPlayers: [], hasOfferedDraw: game.hasOfferedDraw, lastMoves: [] });
    });

    // --- 切断処理 ---
    socket.on('disconnect', () => {
        const mode = socketModes[socket.id];
        if(!mode) return;
        const game = games[mode];

        if (game.players[socket.id]) {
            const pNum = game.players[socket.id].num;
            game.availableSlots.push(pNum);
            game.availableSlots.sort();
            delete game.submittedMoves[pNum];
            delete game.players[socket.id];
            
            if (game.activeDrawOffer) {
                game.activeDrawOffer = null;
                io.to(mode).emit('drawRejected', { rejector: pNum, hasOfferedDraw: game.hasOfferedDraw });
            }
            io.to(mode).emit('playerReady', Object.keys(game.submittedMoves));
            io.to(mode).emit('updateNames', getPlayerNames(mode));
        }
        delete socketModes[socket.id];
    });
});

function processTurn(mode) {
    const game = games[mode];
    game.activeDrawOffer = null;
    io.to(mode).emit('drawRejected', { rejector: 0, hasOfferedDraw: game.hasOfferedDraw }); 

    const priority = PRIORITY_PATTERNS[(game.currentTurn - 1) % 3];
    let movesArr = [];
    for (let p in game.submittedMoves) movesArr.push({ id: parseInt(p), col: game.submittedMoves[p] });
    movesArr.sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));

    game.lastMoves = []; // アニメーション用データをリセット

    movesArr.forEach(m => {
        for (let r = ROWS - 1; r >= 0; r--) {
            if (game.board[r][m.col] === 0) { 
                game.board[r][m.col] = m.id; 
                // ★どこに落ちたかを記録
                game.lastMoves.push({ id: m.id, r: r, c: m.col });
                break; 
            }
        }
    });

    const winner = checkWin(game.board);
    const isDraw = game.board[0].every(c => c !== 0);
    game.submittedMoves = {}; 
    
    if (winner || isDraw) {
        io.to(mode).emit('gameOver', { board: game.board, winner: winner || 0, lastMoves: game.lastMoves });
    } else {
        game.currentTurn++;
        io.to(mode).emit('updateState', { board: game.board, turn: game.currentTurn, readyPlayers: [], hasOfferedDraw: game.hasOfferedDraw, lastMoves: game.lastMoves });
    }
}

function checkWin(board) {
    for(let p=1; p<=3; p++) {
        for(let r=0; r<ROWS; r++) for(let c=0; c<COLS-3; c++) if(board[r][c]==p && board[r][c+1]==p && board[r][c+2]==p && board[r][c+3]==p) return p;
        for(let r=0; r<ROWS-3; r++) for(let c=0; c<COLS; c++) if(board[r][c]==p && board[r+1][c]==p && board[r+2][c]==p && board[r+3][c]==p) return p;
        for(let r=0; r<ROWS-3; r++) for(let c=0; c<COLS-3; c++) if(board[r][c]==p && board[r+1][c+1]==p && board[r+2][c+2]==p && board[r+3][c+3]==p) return p;
        for(let r=3; r<ROWS; r++) for(let c=0; c<COLS-3; c++) if(board[r][c]==p && board[r-1][c+1]==p && board[r-2][c+2]==p && board[r-3][c+3]==p) return p;
    }
    return 0;
}

http.listen(3000, () => console.log('Server running on port 3000'));