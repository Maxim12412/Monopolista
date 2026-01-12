require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
});

// Player colors
const PLAYER_COLORS = ['blue', 'yellow', 'red', 'green'];

function pickNextColor(room) {
  const used = new Set(room.players.map((p) => p.colorKey));
  const next = PLAYER_COLORS.find((c) => !used.has(c));
  return next || 'blue';
}

function isBuyable(tile) {
  return tile && (tile.type === 'property' || tile.type === 'station' || tile.type === 'utility');
}

// ===== Board base (Warsaw) =====
const BOARD_TILES = [
  { id: 0, type: 'start', name: 'START' },

  { id: 1, type: 'property', name: 'Konopacka', price: 60, group: 'brown', setSize: 2, rentLevels: [4, 8] },
  { id: 2, type: 'chest', name: 'Kasa społeczna' },
  { id: 3, type: 'property', name: 'Stalowa', price: 60, group: 'brown', setSize: 2, rentLevels: [4, 8] },
  { id: 4, type: 'tax', name: 'Podatek dochodowy', amount: 200 },
  { id: 5, type: 'station', name: 'Dworzec Zachodni', price: 200, rent: 25 },

  { id: 6, type: 'property', name: 'Radzymińska', price: 100, group: 'lightblue', setSize: 3, rentLevels: [6, 12, 18] },
  { id: 7, type: 'random', name: 'Szansa' },
  { id: 8, type: 'property', name: 'Jagiellońska', price: 100, group: 'lightblue', setSize: 3, rentLevels: [6, 12, 18] },
  { id: 9, type: 'property', name: 'Targowa', price: 120, group: 'lightblue', setSize: 3, rentLevels: [8, 16, 24] },

  { id: 10, type: 'jail', name: 'Więzienie / tylko z wizytą' },

  { id: 11, type: 'property', name: 'Płowiecka', price: 140, group: 'pink', setSize: 3, rentLevels: [10, 20, 30] },
  { id: 12, type: 'utility', name: 'Elektrownia', price: 150 },
  { id: 13, type: 'property', name: 'Marsa', price: 140, group: 'pink', setSize: 3, rentLevels: [10, 20, 30] },
  { id: 14, type: 'property', name: 'Grochowska', price: 160, group: 'pink', setSize: 3, rentLevels: [12, 24, 36] },
  { id: 15, type: 'station', name: 'Dworzec Gdański', price: 200, rent: 25 },

  { id: 16, type: 'property', name: 'Obozowa', price: 180, group: 'orange', setSize: 3, rentLevels: [14, 28, 42] },
  { id: 17, type: 'chest', name: 'Kasa społeczna' },
  { id: 18, type: 'property', name: 'Górczewska', price: 180, group: 'orange', setSize: 3, rentLevels: [14, 28, 42] },
  { id: 19, type: 'property', name: 'Wolska', price: 200, group: 'orange', setSize: 3, rentLevels: [16, 32, 48] },

  { id: 20, type: 'parking', name: 'Bezpłatny parking' },

  { id: 21, type: 'property', name: 'Mickiewicza', price: 220, group: 'red', setSize: 3, rentLevels: [18, 36, 54] },
  { id: 22, type: 'random', name: 'Szansa' },
  { id: 23, type: 'property', name: 'Słowackiego', price: 220, group: 'red', setSize: 3, rentLevels: [18, 36, 54] },
  { id: 24, type: 'property', name: 'Plac Wilsona', price: 240, group: 'red', setSize: 3, rentLevels: [20, 40, 60] },
  { id: 25, type: 'station', name: 'Dworzec Wschodni', price: 200, rent: 25 },

  { id: 26, type: 'property', name: 'Świętokrzyska', price: 260, group: 'yellow', setSize: 3, rentLevels: [22, 44, 66] },
  { id: 27, type: 'property', name: 'Krakowskie Przedmieście', price: 260, group: 'yellow', setSize: 3, rentLevels: [22, 44, 66] },
  { id: 28, type: 'utility', name: 'Wodociągi', price: 150 },
  { id: 29, type: 'property', name: 'Nowy Świat', price: 280, group: 'yellow', setSize: 3, rentLevels: [24, 48, 72] },

  { id: 30, type: 'go_to_jail', name: 'Idź do więzienia' },

  { id: 31, type: 'property', name: 'Plac Trzech Krzyży', price: 300, group: 'green', setSize: 3, rentLevels: [26, 52, 78] },
  { id: 32, type: 'property', name: 'Marszałkowska', price: 300, group: 'green', setSize: 3, rentLevels: [26, 52, 78] },
  { id: 33, type: 'chest', name: 'Kasa społeczna' },
  { id: 34, type: 'property', name: 'Aleje Jerozolimskie', price: 320, group: 'green', setSize: 3, rentLevels: [28, 56, 84] },
  { id: 35, type: 'station', name: 'Dworzec Centralny', price: 200, rent: 25 },

  { id: 36, type: 'random', name: 'Szansa' },
  { id: 37, type: 'property', name: 'Belwederska', price: 350, group: 'darkblue', setSize: 2, rentLevels: [35, 70] },
  { id: 38, type: 'tax', name: 'Domiar podatkowy', amount: 100 },
  { id: 39, type: 'property', name: 'Aleje Ujazdowskie', price: 400, group: 'darkblue', setSize: 2, rentLevels: [50, 100] },
];

const rooms = {};

function createRoomBoard() {
  return BOARD_TILES.map((t) => ({ ...t, ownerId: null }));
}

function createPlayer(socketId, nickname, colorKey) {
  return {
    id: socketId,
    nickname,
    colorKey,
    position: 0,
    balance: 1500,
    properties: [],
    isBankrupt: false,
  };
}

function snapshotRoom(room) {
  return {
    status: room.status,
    hostId: room.hostId,
    readyById: room.readyById,
    players: room.players.map((p) => ({ id: p.id, nickname: p.nickname, colorKey: p.colorKey })),
  };
}

function emitRoomUpdate(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('roomUpdate', snapshotRoom(room));
}

function emitLog(roomCode, text) {
  io.to(roomCode).emit('gameLogEvent', { ts: Date.now(), text });
}

function emitToastToPlayer(playerId, payload) {
  io.to(playerId).emit('toast', payload);
}

function emitGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const current = room.players[room.currentPlayerIndex] || null;
  const winnerPlayer = room.winnerId ? room.players.find((p) => p.id === room.winnerId) : null;

  io.to(roomCode).emit('gameState', {
    roomCode,
    status: room.status,
    phase: room.phase,
    pending: room.pending,
    gameOver: Boolean(room.gameOver),
    winner: winnerPlayer
      ? { id: winnerPlayer.id, nickname: winnerPlayer.nickname, colorKey: winnerPlayer.colorKey }
      : null,
    players: room.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      colorKey: p.colorKey,
      position: p.position,
      balance: p.balance,
      isBankrupt: Boolean(p.isBankrupt),
    })),
    currentPlayerId: current ? current.id : null,
    board: room.board,
  });
}

function allReady(room) {
  if (!room || room.players.length < 2) return false;
  return room.players.every((p) => room.readyById[p.id] === true);
}

function getPlayerById(room, playerId) {
  return room.players.find((p) => p.id === playerId) || null;
}

function getActivePlayers(room) {
  return room.players.filter((p) => !p.isBankrupt);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ===== Rent helpers =====
function countOwnerStations(room, ownerId) {
  return room.board.filter((t) => t.type === 'station' && t.ownerId === ownerId).length;
}
function countOwnerUtilities(room, ownerId) {
  return room.board.filter((t) => t.type === 'utility' && t.ownerId === ownerId).length;
}
function countOwnerGroupProps(room, ownerId, group) {
  return room.board.filter((t) => t.type === 'property' && t.group === group && t.ownerId === ownerId).length;
}

function computeRent(room, tile, diceSum) {
  if (!tile || !tile.ownerId) return 0;

  if (tile.type === 'property') {
    const ownedInGroup = countOwnerGroupProps(room, tile.ownerId, tile.group);
    if (!Array.isArray(tile.rentLevels) || tile.rentLevels.length === 0) return 0;
    const idx = clamp(ownedInGroup, 1, tile.rentLevels.length) - 1;
    return Number(tile.rentLevels[idx] || 0);
  }

  if (tile.type === 'station') {
    const stations = countOwnerStations(room, tile.ownerId);
    const base = Number(tile.rent || 25);
    const mult = Math.pow(2, clamp(stations, 1, 4) - 1);
    return base * mult;
  }

  if (tile.type === 'utility') {
    const utils = countOwnerUtilities(room, tile.ownerId);
    const multiplier = utils >= 2 ? 10 : 4;
    return Number(diceSum) * multiplier;
  }

  return 0;
}

// ===== Turn helpers (skip bankrupt players) =====
function ensureCurrentIsActive(room) {
  if (room.players.length === 0) return;
  const triesMax = room.players.length;
  let tries = 0;
  while (tries < triesMax && room.players[room.currentPlayerIndex]?.isBankrupt) {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    tries += 1;
  }
}

function advanceTurn(room) {
  if (room.players.length === 0) return;
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  ensureCurrentIsActive(room);
}

// ===== Bankruptcy / Winner =====
function releasePropertiesToBank(room, playerId) {
  room.board.forEach((t) => {
    if (t.ownerId === playerId) t.ownerId = null;
  });
}

function checkWinner(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const active = getActivePlayers(room);
  if (active.length === 1) {
    room.gameOver = true;
    room.winnerId = active[0].id;
    room.phase = 'awaiting_roll';
    room.pending = null;

    emitLog(roomCode, `Zwycięzca: ${active[0].nickname}.`);
    emitGameState(roomCode);
  }
}

function handleBankruptcy(roomCode, playerId) {
  const room = rooms[roomCode];
  if (!room || room.gameOver) return false;

  const pl = getPlayerById(room, playerId);
  if (!pl || pl.isBankrupt) return false;
  if (pl.balance >= 0) return false;

  pl.isBankrupt = true;
  pl.balance = 0;
  pl.properties = [];

  releasePropertiesToBank(room, pl.id);

  emitLog(roomCode, `Gracz ${pl.nickname} zbankrutował.`);
  emitToastToPlayer(pl.id, { type: 'err', text: 'Bankructwo!' });

  // If bankrupt player was current, move to next active
  ensureCurrentIsActive(room);

  room.phase = 'awaiting_roll';
  room.pending = null;

  emitGameState(roomCode);
  checkWinner(roomCode);

  return true;
}

function resetGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.board = createRoomBoard();
  room.phase = 'awaiting_roll';
  room.pending = null;
  room.currentPlayerIndex = 0;
  room.gameOver = false;
  room.winnerId = null;

  room.players.forEach((p) => {
    p.position = 0;
    p.balance = 1500;
    p.properties = [];
    p.isBankrupt = false;
  });

  ensureCurrentIsActive(room);

  io.to(roomCode).emit('gameReset');
  emitLog(roomCode, `Nowa gra rozpoczęta. Pierwszy ruch: ${room.players[room.currentPlayerIndex]?.nickname || '-'}.`);
  emitGameState(roomCode);
}

// ===== Socket.IO =====
io.on('connection', (socket) => {
  socket.on('createRoom', ({ nickname }, callback) => {
    try {
      const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
      const room = {
        hostId: socket.id,
        readyById: { [socket.id]: true },
        players: [],
        status: 'waiting',
        currentPlayerIndex: 0,
        board: createRoomBoard(),
        phase: 'awaiting_roll',
        pending: null,
        gameOver: false,
        winnerId: null,
      };

      const colorKey = pickNextColor(room);
      room.players.push(createPlayer(socket.id, nickname, colorKey));
      rooms[roomCode] = room;

      socket.join(roomCode);
      callback?.({ ok: true, roomCode, room: snapshotRoom(room) });

      emitRoomUpdate(roomCode);
      emitLog(roomCode, `Pokój utworzony. Host: ${nickname}.`);
    } catch (e) {
      callback?.({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('joinRoom', ({ roomCode, nickname }, callback) => {
    try {
      roomCode = String(roomCode || '').toUpperCase();
      const room = rooms[roomCode];

      if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
      if (room.status !== 'waiting') return callback?.({ ok: false, error: 'GAME_ALREADY_STARTED' });
      if (room.players.length >= 6) return callback?.({ ok: false, error: 'ROOM_FULL' });

      if (room.players.some((p) => p.id === socket.id)) {
        socket.join(roomCode);
        return callback?.({ ok: true, roomCode, room: snapshotRoom(room) });
      }

      if (room.players.some((p) => p.nickname === nickname)) {
        return callback?.({ ok: false, error: 'NICKNAME_TAKEN' });
      }

      const colorKey = pickNextColor(room);
      room.players.push(createPlayer(socket.id, nickname, colorKey));
      room.readyById[socket.id] = false;

      socket.join(roomCode);
      callback?.({ ok: true, roomCode, room: snapshotRoom(room) });

      emitRoomUpdate(roomCode);
      emitLog(roomCode, `Gracz ${nickname} dołączył do pokoju.`);
    } catch (e) {
      callback?.({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('setReady', ({ roomCode, ready }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false });
    if (room.status !== 'waiting') return callback?.({ ok: false });

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return callback?.({ ok: false });

    room.readyById[socket.id] = Boolean(ready);
    emitRoomUpdate(roomCode);
    emitLog(roomCode, `${player.nickname} jest ${room.readyById[socket.id] ? 'gotowy' : 'nie gotowy'}.`);
    callback?.({ ok: true });
  });

  socket.on('startGame', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.status !== 'waiting') return callback?.({ ok: false, error: 'ALREADY_PLAYING' });
    if (socket.id !== room.hostId) {
      emitLog(roomCode, 'Tylko host może rozpocząć grę.');
      return callback?.({ ok: false, error: 'NOT_HOST' });
    }
    if (!allReady(room)) {
      emitLog(roomCode, 'Nie wszyscy gracze są gotowi (minimum 2 graczy).');
      return callback?.({ ok: false, error: 'NOT_READY' });
    }

    room.status = 'playing';
    room.board = createRoomBoard();
    room.phase = 'awaiting_roll';
    room.pending = null;
    room.currentPlayerIndex = 0;
    room.gameOver = false;
    room.winnerId = null;

    room.players.forEach((p) => {
      p.position = 0;
      p.balance = 1500;
      p.properties = [];
      p.isBankrupt = false;
    });

    ensureCurrentIsActive(room);

    emitRoomUpdate(roomCode);
    emitGameState(roomCode);
    emitLog(roomCode, `Gra rozpoczęta. Pierwszy ruch: ${room.players[room.currentPlayerIndex].nickname}.`);
    callback?.({ ok: true });
  });

  socket.on('restartGame', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (socket.id !== room.hostId) return callback?.({ ok: false, error: 'NOT_HOST' });

    resetGame(roomCode);
    callback?.({ ok: true });
  });

  socket.on('sendMessage', ({ roomCode, nickname, message }) => {
    io.to(roomCode).emit('newMessage', { nickname, message, timestamp: new Date().toISOString() });
  });

  socket.on('rollDice', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (room.gameOver) return callback?.({ ok: false, error: 'GAME_OVER' });
    if (room.phase !== 'awaiting_roll') return callback?.({ ok: false, error: 'WAITING_FOR_BUY' });

    ensureCurrentIsActive(room);

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer) return callback?.({ ok: false, error: 'NO_CURRENT_PLAYER' });
    if (currentPlayer.isBankrupt) return callback?.({ ok: false, error: 'BANKRUPT' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });

    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const steps = dice1 + dice2;

    let newPosition = currentPlayer.position + steps;
    if (newPosition >= room.board.length) {
      newPosition = newPosition % room.board.length;
      currentPlayer.balance += 200;
      emitLog(roomCode, `${currentPlayer.nickname} przeszedł przez START i otrzymał +200.`);
      emitToastToPlayer(currentPlayer.id, { type: 'ok', text: 'START: +200' });
    }

    currentPlayer.position = newPosition;
    const tile = room.board[newPosition];

    io.to(roomCode).emit('diceRolled', {
      playerId: currentPlayer.id,
      nickname: currentPlayer.nickname,
      dice1,
      dice2,
      steps,
      newPosition,
      tile,
    });

    emitLog(roomCode, `${currentPlayer.nickname} rzucił ${dice1}+${dice2}=${steps} → ${tile.name}.`);

    const diceSum = steps;

    // TAX
    if (tile.type === 'tax' && typeof tile.amount === 'number') {
      currentPlayer.balance -= tile.amount;
      emitLog(roomCode, `${currentPlayer.nickname} zapłacił podatek ${tile.amount} na polu "${tile.name}".`);
      emitToastToPlayer(currentPlayer.id, { type: 'err', text: `Podatek: -${tile.amount} (${tile.name})` });

      if (handleBankruptcy(roomCode, currentPlayer.id)) {
        // turn ends if bankrupt
        advanceTurn(room);
        emitGameState(roomCode);
        return callback?.({ ok: true, phase: 'awaiting_roll' });
      }
    }

    // RENT
    if (isBuyable(tile) && tile.ownerId && tile.ownerId !== currentPlayer.id) {
      const owner = getPlayerById(room, tile.ownerId);
      const rent = computeRent(room, tile, diceSum);

      if (owner && rent > 0) {
        currentPlayer.balance -= rent;
        owner.balance += rent;

        emitLog(roomCode, `${currentPlayer.nickname} zapłacił czynsz ${rent} dla ${owner.nickname} (${tile.name}).`);
        emitToastToPlayer(currentPlayer.id, { type: 'err', text: `Czynsz: -${rent} → ${owner.nickname} (${tile.name})` });
        emitToastToPlayer(owner.id, { type: 'ok', text: `Czynsz: +${rent} od ${currentPlayer.nickname} (${tile.name})` });

        if (handleBankruptcy(roomCode, currentPlayer.id)) {
          advanceTurn(room);
          emitGameState(roomCode);
          return callback?.({ ok: true, phase: 'awaiting_roll' });
        }
      } else {
        emitLog(roomCode, `Nie udało się naliczyć czynszu dla pola "${tile.name}".`);
      }
    }

    emitGameState(roomCode);

    // Buy phase if unowned
    if (isBuyable(tile) && !tile.ownerId && typeof tile.price === 'number') {
      room.phase = 'awaiting_buy';
      room.pending = { playerId: currentPlayer.id, tileId: tile.id };
      emitGameState(roomCode);
      return callback?.({ ok: true, phase: 'awaiting_buy' });
    }

    // End turn
    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);
    emitGameState(roomCode);
    callback?.({ ok: true, phase: 'awaiting_roll' });
  });

  socket.on('buyTile', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (room.gameOver) return callback?.({ ok: false, error: 'GAME_OVER' });

    ensureCurrentIsActive(room);

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer) return callback?.({ ok: false, error: 'NO_CURRENT_PLAYER' });
    if (currentPlayer.isBankrupt) return callback?.({ ok: false, error: 'BANKRUPT' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });

    if (room.phase !== 'awaiting_buy' || !room.pending || room.pending.playerId !== socket.id) {
      return callback?.({ ok: false, error: 'NOT_IN_BUY_PHASE' });
    }

    const tile = room.board[currentPlayer.position];
    if (!isBuyable(tile)) return callback?.({ ok: false, error: 'NOT_BUYABLE' });
    if (tile.ownerId) return callback?.({ ok: false, error: 'ALREADY_OWNED' });
    if (typeof tile.price !== 'number') return callback?.({ ok: false, error: 'NO_PRICE' });
    if (currentPlayer.balance < tile.price) return callback?.({ ok: false, error: 'NO_MONEY' });

    tile.ownerId = currentPlayer.id;
    currentPlayer.balance -= tile.price;
    currentPlayer.properties.push(tile.id);

    emitLog(roomCode, `${currentPlayer.nickname} kupił ${tile.name} za ${tile.price}.`);
    emitToastToPlayer(currentPlayer.id, { type: 'ok', text: `Kupiono: ${tile.name} (-${tile.price})` });

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);

    emitGameState(roomCode);
    callback?.({ ok: true });
  });

  socket.on('skipBuy', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (room.gameOver) return callback?.({ ok: false, error: 'GAME_OVER' });

    ensureCurrentIsActive(room);

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer) return callback?.({ ok: false, error: 'NO_CURRENT_PLAYER' });
    if (currentPlayer.isBankrupt) return callback?.({ ok: false, error: 'BANKRUPT' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });

    if (room.phase !== 'awaiting_buy' || !room.pending || room.pending.playerId !== socket.id) {
      return callback?.({ ok: false, error: 'NOT_IN_BUY_PHASE' });
    }

    emitLog(roomCode, `${currentPlayer.nickname} nie kupił pola i kończy turę.`);
    emitToastToPlayer(currentPlayer.id, { type: 'ok', text: 'Pominięto zakup' });

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);

    emitGameState(roomCode);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const roomCode of Object.keys(rooms)) {
      const room = rooms[roomCode];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) continue;

      const left = room.players[idx];

      // If player leaves during play, release their properties
      if (room.status === 'playing') {
        releasePropertiesToBank(room, left.id);
      }

      room.players.splice(idx, 1);
      delete room.readyById[left.id];

      emitLog(roomCode, `Gracz ${left.nickname} opuścił grę.`);

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return;
      }

      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
        room.readyById[room.hostId] = true;
        emitLog(roomCode, `Nowy host: ${room.players[0].nickname}.`);
      }

      if (room.currentPlayerIndex >= room.players.length) room.currentPlayerIndex = 0;
      ensureCurrentIsActive(room);

      emitRoomUpdate(roomCode);
      if (room.status === 'playing') {
        emitGameState(roomCode);
        checkWinner(roomCode);
      }
    }
  });
});

app.get('/', (req, res) => res.send('Monopolista server is running'));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
