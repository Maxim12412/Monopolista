require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
});

// ===== MongoDB (persistence) =====
const MONGODB_URI = process.env.MONGODB_URI || '';

const RoomStateSchema = new mongoose.Schema(
  {
    roomCode: { type: String, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const RoomState = mongoose.model('RoomState', RoomStateSchema);

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn('[MongoDB] MONGODB_URI is missing. Persistence is disabled.');
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    console.log('[MongoDB] Connected');
  } catch (e) {
    console.error('[MongoDB] Connection failed:', e?.message || e);
  }
}

function isMongoReady() {
  return mongoose.connection?.readyState === 1;
}

function safeClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function roomToPersisted(room) {
  return {
    hostId: room.hostId,
    readyById: room.readyById,
    players: (room.players || []).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      colorKey: p.colorKey,
      position: p.position,
      balance: p.balance,
      properties: p.properties || [],
      isBankrupt: Boolean(p.isBankrupt),
      inJail: Boolean(p.inJail),
      jailTurnsLeft: Number(p.jailTurnsLeft || 0),
      isDisconnected: Boolean(p.isDisconnected),
      disconnectedAt: p.disconnectedAt ? Number(p.disconnectedAt) : null,
    })),
    status: room.status,
    currentPlayerIndex: room.currentPlayerIndex,
    phase: room.phase,
    pending: room.pending,
    gameOver: Boolean(room.gameOver),
    winnerId: room.winnerId || null,
    board: room.board,
    chanceDeck: room.chanceDeck || [],
    chancePos: room.chancePos || 0,
    communityDeck: room.communityDeck || [],
    communityPos: room.communityPos || 0,
    logHistory: room.logHistory || [],
  };
}

function persistedToRoom(data) {
  const room = {
    hostId: data.hostId || null,
    readyById: data.readyById || {},
    players: Array.isArray(data.players) ? data.players : [],
    status: data.status || 'waiting',
    currentPlayerIndex: Number.isFinite(data.currentPlayerIndex) ? data.currentPlayerIndex : 0,
    board: Array.isArray(data.board) ? data.board : [],
    phase: data.phase || 'awaiting_roll',
    pending: data.pending || null,
    gameOver: Boolean(data.gameOver),
    winnerId: data.winnerId || null,
    chanceDeck: Array.isArray(data.chanceDeck) ? data.chanceDeck : [],
    chancePos: Number.isFinite(data.chancePos) ? data.chancePos : 0,
    communityDeck: Array.isArray(data.communityDeck) ? data.communityDeck : [],
    communityPos: Number.isFinite(data.communityPos) ? data.communityPos : 0,
    logHistory: Array.isArray(data.logHistory) ? data.logHistory : [],
  };
  return room;
}

async function saveRoomNow(roomCode) {
  if (!isMongoReady()) return;
  const room = rooms[roomCode];
  if (!room) return;

  try {
    const data = roomToPersisted(room);
    await RoomState.updateOne(
      { roomCode },
      { $set: { roomCode, data } },
      { upsert: true }
    );
  } catch (e) {
    console.error('[MongoDB] Save failed:', e?.message || e);
  }
}

function scheduleSave(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (!isMongoReady()) return;

  if (room._saveTimer) return;
  room._saveTimer = setTimeout(async () => {
    room._saveTimer = null;
    await saveRoomNow(roomCode);
  }, 400);
}

async function loadRoomFromDb(roomCode) {
  if (!isMongoReady()) return null;
  const doc = await RoomState.findOne({ roomCode }).lean();
  if (!doc || !doc.data) return null;
  return persistedToRoom(doc.data);
}

async function deleteRoomFromDb(roomCode) {
  if (!isMongoReady()) return;
  try {
    await RoomState.deleteOne({ roomCode });
  } catch (e) {
    console.error('[MongoDB] Delete failed:', e?.message || e);
  }
}

// ===== Player colors =====
const PLAYER_COLORS = ['blue', 'yellow', 'red', 'green'];

function pickNextColor(room) {
  const used = new Set((room.players || []).map((p) => p.colorKey));
  const next = PLAYER_COLORS.find((c) => !used.has(c));
  return next || 'blue';
}

function isBuyable(tile) {
  return tile && (tile.type === 'property' || tile.type === 'station' || tile.type === 'utility');
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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

const JAIL_TILE_ID = 10;
const JAIL_FINE = 50;

// ===== Cards =====
const CHANCE_CARDS = [
  { id: 'ch_1', text: 'Otrzymujesz +200.', effect: { type: 'money', amount: 200 } },
  { id: 'ch_2', text: 'Otrzymujesz +25.', effect: { type: 'money', amount: 25 } },
  { id: 'ch_3', text: 'Zapłać -50.', effect: { type: 'money', amount: -50 } },
  { id: 'ch_4', text: 'Przesuń się o +3 pola.', effect: { type: 'moveSteps', steps: 3 } },
  { id: 'ch_5', text: 'Cofnij się o -2 pola.', effect: { type: 'moveSteps', steps: -2 } },
  { id: 'ch_6', text: 'Idź do więzienia.', effect: { type: 'goToJail' } },
  { id: 'ch_7', text: 'Idź na START (możesz otrzymać +200 za przejście przez START).', effect: { type: 'moveTo', tileId: 0 } },
  { id: 'ch_8', text: 'Idź na "Dworzec Centralny".', effect: { type: 'moveTo', tileId: 35 } },
];

const COMMUNITY_CARDS = [
  { id: 'co_1', text: 'Otrzymujesz zwrot podatku +200.', effect: { type: 'money', amount: 200 } },
  { id: 'co_2', text: 'Zapłać rachunek -100.', effect: { type: 'money', amount: -100 } },
  { id: 'co_3', text: 'Otrzymujesz prezent +50.', effect: { type: 'money', amount: 50 } },
  { id: 'co_4', text: 'Cofnij się o -3 pola.', effect: { type: 'moveSteps', steps: -3 } },
  { id: 'co_5', text: 'Przesuń się o +2 pola.', effect: { type: 'moveSteps', steps: 2 } },
  { id: 'co_6', text: 'Idź do więzienia.', effect: { type: 'goToJail' } },
  { id: 'co_7', text: 'Idź na "Podatek dochodowy".', effect: { type: 'moveTo', tileId: 4 } },
];

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
    inJail: false,
    jailTurnsLeft: 0,
    isDisconnected: false,
    disconnectedAt: null,
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

function appendLog(roomCode, text) {
  const room = rooms[roomCode];
  if (!room) return;

  if (!Array.isArray(room.logHistory)) room.logHistory = [];
  room.logHistory.push({ ts: Date.now(), text });
  if (room.logHistory.length > 250) room.logHistory = room.logHistory.slice(-250);

  io.to(roomCode).emit('gameLogEvent', { ts: Date.now(), text });
  scheduleSave(roomCode);
}

function emitToastToPlayer(playerId, payload) {
  io.to(playerId).emit('toast', payload);
}

function emitPaymentPromptToPlayer(playerId, payload) {
  io.to(playerId).emit('paymentPrompt', payload);
  io.to(playerId).emit('payment_prompt', payload);
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
      inJail: Boolean(p.inJail),
      jailTurnsLeft: Number(p.jailTurnsLeft || 0),
      isDisconnected: Boolean(p.isDisconnected),
    })),
    currentPlayerId: current ? current.id : null,
    board: room.board,
  });

  scheduleSave(roomCode);
}

function allReady(room) {
  if (!room || room.players.length < 2) return false;
  return room.players.every((p) => room.readyById[p.id] === true);
}

function getPlayerById(room, playerId) {
  return room.players.find((p) => p.id === playerId) || null;
}

function getActivePlayers(room) {
  // IMPORTANT: disconnected players are still "active" (do not end game)
  return room.players.filter((p) => !p.isBankrupt);
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

// ===== Turn helpers =====
function ensureCurrentIsActive(room) {
  if (room.players.length === 0) return;

  const triesMax = room.players.length;
  let tries = 0;

  // Skip bankrupt OR disconnected players to avoid stuck turns
  while (
    tries < triesMax &&
    (room.players[room.currentPlayerIndex]?.isBankrupt || room.players[room.currentPlayerIndex]?.isDisconnected)
  ) {
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

    appendLog(roomCode, `Zwycięzca: ${active[0].nickname}.`);
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
  pl.inJail = false;
  pl.jailTurnsLeft = 0;

  releasePropertiesToBank(room, pl.id);

  appendLog(roomCode, `Gracz ${pl.nickname} zbankrutował.`);
  emitToastToPlayer(pl.id, { type: 'err', text: 'Bankructwo!' });

  ensureCurrentIsActive(room);

  room.phase = 'awaiting_roll';
  room.pending = null;

  emitGameState(roomCode);
  checkWinner(roomCode);

  return true;
}

// ===== Movement paths (animation) =====
function buildForwardPath(startPos, steps, len) {
  const path = [];
  let pos = startPos;
  for (let i = 0; i < steps; i += 1) {
    pos = (pos + 1) % len;
    path.push(pos);
  }
  return path;
}

function buildBackwardPath(startPos, stepsAbs, len) {
  const path = [];
  let pos = startPos;
  for (let i = 0; i < stepsAbs; i += 1) {
    pos = (pos - 1 + len) % len;
    path.push(pos);
  }
  return path;
}

function buildPathToForward(startPos, targetPos, len) {
  const path = [];
  let pos = startPos;
  while (pos !== targetPos) {
    pos = (pos + 1) % len;
    path.push(pos);
    if (path.length > len + 2) break;
  }
  return path;
}

// ===== Cards / Jail =====
function initDecks(room) {
  room.chanceDeck = shuffleArray(CHANCE_CARDS);
  room.chancePos = 0;

  room.communityDeck = shuffleArray(COMMUNITY_CARDS);
  room.communityPos = 0;
}

function drawCard(room, deckType) {
  const isChance = deckType === 'chance';

  const deck = isChance ? room.chanceDeck : room.communityDeck;
  let pos = isChance ? room.chancePos : room.communityPos;

  if (!Array.isArray(deck) || deck.length === 0) return null;

  if (pos >= deck.length) pos = 0;
  const card = deck[pos];

  pos += 1;
  if (isChance) room.chancePos = pos;
  else room.communityPos = pos;

  return card || null;
}

function sendToJail(roomCode, room, player, reason = 'jail') {
  player.position = JAIL_TILE_ID;
  player.inJail = true;
  player.jailTurnsLeft = 1;

  io.to(roomCode).emit('playerMovePath', { playerId: player.id, path: [JAIL_TILE_ID], reason });

  appendLog(roomCode, `${player.nickname} idzie do więzienia.`);
  emitToastToPlayer(player.id, { type: 'err', text: 'Więzienie' });
}

function maybePromptJail(roomCode, room, player) {
  if (!player.inJail || player.jailTurnsLeft <= 0) return false;

  room.phase = 'awaiting_jail_choice';
  room.pending = { type: 'jail', playerId: player.id, fine: JAIL_FINE };

  emitGameState(roomCode);

  io.to(player.id).emit('jailPrompt', { playerId: player.id, fine: JAIL_FINE });
  io.to(player.id).emit('jail_prompt', { playerId: player.id, fine: JAIL_FINE });

  appendLog(roomCode, `${player.nickname} jest w więzieniu: wybór (zapłać ${JAIL_FINE} lub pomiń turę).`);
  return true;
}

function resolveLanding(roomCode, room, player, diceSum, fromCard = false) {
  const tile = room.board[player.position];

  if (tile.type === 'go_to_jail') {
    sendToJail(roomCode, room, player, 'tile');

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);
    emitGameState(roomCode);
    checkWinner(roomCode);

    return { phase: 'awaiting_roll', endedTurn: true };
  }

  if (tile.type === 'tax' && typeof tile.amount === 'number') {
    const taxAmount = Number(tile.amount);
    player.balance -= taxAmount;

    appendLog(roomCode, `${player.nickname} zapłacił podatek ${taxAmount} na polu "${tile.name}".`);
    emitToastToPlayer(player.id, { type: 'err', text: `Podatek: -${taxAmount} (${tile.name})` });

    emitPaymentPromptToPlayer(player.id, { type: 'tax', amount: taxAmount, tileName: tile.name });

    if (handleBankruptcy(roomCode, player.id)) {
      advanceTurn(room);
      emitGameState(roomCode);
      return { phase: 'awaiting_roll', endedTurn: true };
    }
  }

  if (isBuyable(tile) && tile.ownerId && tile.ownerId !== player.id) {
    const owner = getPlayerById(room, tile.ownerId);
    const rent = computeRent(room, tile, diceSum);

    if (owner && rent > 0) {
      player.balance -= rent;
      owner.balance += rent;

      appendLog(roomCode, `${player.nickname} zapłacił czynsz ${rent} dla ${owner.nickname} (${tile.name}).`);
      emitToastToPlayer(player.id, { type: 'err', text: `Czynsz: -${rent} → ${owner.nickname} (${tile.name})` });
      emitToastToPlayer(owner.id, { type: 'ok', text: `Czynsz: +${rent} od ${player.nickname} (${tile.name})` });

      emitPaymentPromptToPlayer(player.id, {
        type: 'rent',
        amount: rent,
        toNickname: owner.nickname,
        tileName: tile.name,
      });

      if (handleBankruptcy(roomCode, player.id)) {
        advanceTurn(room);
        emitGameState(roomCode);
        return { phase: 'awaiting_roll', endedTurn: true };
      }
    } else {
      appendLog(roomCode, `Nie udało się naliczyć czynszu dla pola "${tile.name}".`);
    }
  }

  if (!fromCard && (tile.type === 'random' || tile.type === 'chest')) {
    const deckType = tile.type === 'random' ? 'chance' : 'community';
    const deckLabel = deckType === 'chance' ? 'Szansa' : 'Kasa społeczna';

    const card = drawCard(room, deckType);
    if (card) {
      appendLog(roomCode, `${player.nickname} wylosował kartę: ${deckLabel} — "${card.text}".`);

      room.phase = 'awaiting_card_ack';
      room.pending = {
        type: 'card',
        playerId: player.id,
        deckType,
        deckLabel,
        card,
        diceSum: Number(diceSum || 0),
      };

      emitGameState(roomCode);

      io.to(player.id).emit('cardDrawn', {
        deckType,
        deckLabel,
        text: card.text,
        playerId: player.id,
        nickname: player.nickname,
        colorKey: player.colorKey,
      });
      io.to(player.id).emit('card_drawn', {
        deckType,
        deckLabel,
        text: card.text,
        playerId: player.id,
        nickname: player.nickname,
        colorKey: player.colorKey,
      });

      return { phase: 'awaiting_card_ack', endedTurn: false };
    }
  }

  emitGameState(roomCode);

  if (isBuyable(tile) && !tile.ownerId && typeof tile.price === 'number') {
    room.phase = 'awaiting_buy';
    room.pending = { playerId: player.id, tileId: tile.id };
    emitGameState(roomCode);
    return { phase: 'awaiting_buy', endedTurn: false };
  }

  room.phase = 'awaiting_roll';
  room.pending = null;
  advanceTurn(room);
  emitGameState(roomCode);
  return { phase: 'awaiting_roll', endedTurn: true };
}

function applyCardEffectAfterAck(roomCode, room, player, pendingCard) {
  const card = pendingCard.card;
  const diceSum = Number(pendingCard.diceSum || 0);
  const eff = card?.effect || null;

  if (!eff || !eff.type) {
    appendLog(roomCode, 'Efekt: brak.');
    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);
    emitGameState(roomCode);
    return { phase: 'awaiting_roll', endedTurn: true };
  }

  if (eff.type === 'money') {
    const amt = Number(eff.amount || 0);
    player.balance += amt;

    if (amt >= 0) {
      appendLog(roomCode, `Efekt: ${player.nickname} otrzymał +${amt}.`);
      emitToastToPlayer(player.id, { type: 'ok', text: `+${amt}` });
    } else {
      appendLog(roomCode, `Efekt: ${player.nickname} zapłacił ${Math.abs(amt)}.`);
      emitToastToPlayer(player.id, { type: 'err', text: `-${Math.abs(amt)}` });
      emitPaymentPromptToPlayer(player.id, { type: 'fee', amount: Math.abs(amt), label: 'Opłata' });
    }

    if (handleBankruptcy(roomCode, player.id)) {
      room.phase = 'awaiting_roll';
      room.pending = null;
      advanceTurn(room);
      emitGameState(roomCode);
      checkWinner(roomCode);
      return { phase: 'awaiting_roll', endedTurn: true };
    }

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);
    emitGameState(roomCode);
    return { phase: 'awaiting_roll', endedTurn: true };
  }

  if (eff.type === 'goToJail') {
    appendLog(roomCode, `Efekt: ${player.nickname} idzie do więzienia.`);
    sendToJail(roomCode, room, player, 'card');

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);
    emitGameState(roomCode);
    checkWinner(roomCode);
    return { phase: 'awaiting_roll', endedTurn: true };
  }

  if (eff.type === 'moveSteps') {
    const steps = Number(eff.steps || 0);
    const len = room.board.length;
    const startPos = player.position;

    let path = [];
    if (steps >= 0) path = buildForwardPath(startPos, steps, len);
    else path = buildBackwardPath(startPos, Math.abs(steps), len);

    if (path.length > 0) {
      player.position = path[path.length - 1];
      io.to(roomCode).emit('playerMovePath', { playerId: player.id, path, reason: 'card' });
    }

    appendLog(roomCode, `Efekt: ${player.nickname} przesuwa się o ${steps} pola.`);
    return resolveLanding(roomCode, room, player, diceSum, true);
  }

  if (eff.type === 'moveTo') {
    const len = room.board.length;
    const startPos = player.position;
    let target = Number(eff.tileId || 0) % len;
    if (target < 0) target += len;

    const path = buildPathToForward(startPos, target, len);

    if (target < startPos) {
      player.balance += 200;
      appendLog(roomCode, `${player.nickname} przeszedł przez START i otrzymał +200.`);
      emitToastToPlayer(player.id, { type: 'ok', text: 'START: +200' });
    }

    player.position = target;
    io.to(roomCode).emit('playerMovePath', { playerId: player.id, path: path.length ? path : [target], reason: 'card' });

    appendLog(roomCode, `Efekt: ${player.nickname} idzie na pole: ${room.board[target]?.name || target}.`);
    return resolveLanding(roomCode, room, player, diceSum, true);
  }

  appendLog(roomCode, 'Efekt: nieznany.');
  room.phase = 'awaiting_roll';
  room.pending = null;
  advanceTurn(room);
  emitGameState(roomCode);
  return { phase: 'awaiting_roll', endedTurn: true };
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
    p.inJail = false;
    p.jailTurnsLeft = 0;
    p.isDisconnected = false;
    p.disconnectedAt = null;
  });

  initDecks(room);
  ensureCurrentIsActive(room);

  io.to(roomCode).emit('gameReset');
  appendLog(roomCode, `Nowa gra rozpoczęta. Pierwszy ruch: ${room.players[room.currentPlayerIndex]?.nickname || '-'}.`);
  emitGameState(roomCode);
  scheduleSave(roomCode);
}

// ===== Rebind socket id on rejoin =====
function rebindPlayerId(room, oldId, newId) {
  if (!room || !oldId || !newId) return;

  room.players.forEach((p) => {
    if (p.id === oldId) p.id = newId;
  });

  if (room.hostId === oldId) room.hostId = newId;
  if (room.winnerId === oldId) room.winnerId = newId;

  if (room.readyById) {
    const val = room.readyById[oldId];
    delete room.readyById[oldId];
    room.readyById[newId] = val;
  }

  if (Array.isArray(room.board)) {
    room.board.forEach((t) => {
      if (t.ownerId === oldId) t.ownerId = newId;
    });
  }

  if (room.pending && room.pending.playerId === oldId) {
    room.pending.playerId = newId;
  }
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
        chanceDeck: [],
        chancePos: 0,
        communityDeck: [],
        communityPos: 0,
        logHistory: [],
      };

      const colorKey = pickNextColor(room);
      room.players.push(createPlayer(socket.id, nickname, colorKey));
      initDecks(room);

      rooms[roomCode] = room;
      socket.join(roomCode);

      callback?.({ ok: true, roomCode, room: snapshotRoom(room) });

      emitRoomUpdate(roomCode);
      appendLog(roomCode, `Pokój utworzony. Host: ${nickname}.`);
      emitGameState(roomCode);
      scheduleSave(roomCode);
    } catch (e) {
      callback?.({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  socket.on('joinRoom', async ({ roomCode, nickname }, callback) => {
    try {
      roomCode = String(roomCode || '').toUpperCase();

      if (!rooms[roomCode] && isMongoReady()) {
        const loaded = await loadRoomFromDb(roomCode);
        if (loaded) rooms[roomCode] = loaded;
      }

      const room = rooms[roomCode];
      if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });

      // If playing: allow rejoin only by nickname existing in room
      if (room.status !== 'waiting') {
        const existingByNick = room.players.find((p) => p.nickname === nickname) || null;
        if (!existingByNick) return callback?.({ ok: false, error: 'GAME_ALREADY_STARTED' });

        const oldId = existingByNick.id;
        rebindPlayerId(room, oldId, socket.id);

        // Mark as connected again
        const nowPlayer = room.players.find((p) => p.id === socket.id) || null;
        if (nowPlayer) {
          nowPlayer.isDisconnected = false;
          nowPlayer.disconnectedAt = null;
        }

        socket.join(roomCode);

        callback?.({ ok: true, roomCode, room: snapshotRoom(room) });
        socket.emit('logHistory', room.logHistory || []);

        emitRoomUpdate(roomCode);
        emitGameState(roomCode);
        appendLog(roomCode, `Gracz ${nickname} wrócił do gry.`);
        scheduleSave(roomCode);
        return;
      }

      // Waiting room rules
      if (room.players.length >= 6) return callback?.({ ok: false, error: 'ROOM_FULL' });

      if (room.players.some((p) => p.id === socket.id)) {
        socket.join(roomCode);
        callback?.({ ok: true, roomCode, room: snapshotRoom(room) });
        socket.emit('logHistory', room.logHistory || []);
        emitRoomUpdate(roomCode);
        emitGameState(roomCode);
        return;
      }

      if (room.players.some((p) => p.nickname === nickname)) {
        return callback?.({ ok: false, error: 'NICKNAME_TAKEN' });
      }

      const colorKey = pickNextColor(room);
      room.players.push(createPlayer(socket.id, nickname, colorKey));
      room.readyById[socket.id] = false;

      socket.join(roomCode);
      callback?.({ ok: true, roomCode, room: snapshotRoom(room) });

      socket.emit('logHistory', room.logHistory || []);
      emitRoomUpdate(roomCode);
      appendLog(roomCode, `Gracz ${nickname} dołączył do pokoju.`);
      emitGameState(roomCode);
      scheduleSave(roomCode);
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
    appendLog(roomCode, `${player.nickname} jest ${room.readyById[socket.id] ? 'gotowy' : 'nie gotowy'}.`);
    callback?.({ ok: true });
    scheduleSave(roomCode);
  });

  socket.on('startGame', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.status !== 'waiting') return callback?.({ ok: false, error: 'ALREADY_PLAYING' });
    if (socket.id !== room.hostId) {
      appendLog(roomCode, 'Tylko host może rozpocząć grę.');
      return callback?.({ ok: false, error: 'NOT_HOST' });
    }
    if (!allReady(room)) {
      appendLog(roomCode, 'Nie wszyscy gracze są gotowi (minimum 2 graczy).');
      return callback?.({ ok: false, error: 'NOT_READY' });
    }

    room.status = 'playing';
    room.board = createRoomBoard();
    room.phase = 'awaiting_roll';
    room.pending = null;
    room.currentPlayerIndex = 0;
    room.gameOver = false;
    room.winnerId = null;
    room.logHistory = room.logHistory || [];

    room.players.forEach((p) => {
      p.position = 0;
      p.balance = 1500;
      p.properties = [];
      p.isBankrupt = false;
      p.inJail = false;
      p.jailTurnsLeft = 0;
      p.isDisconnected = false;
      p.disconnectedAt = null;
    });

    initDecks(room);
    ensureCurrentIsActive(room);

    emitRoomUpdate(roomCode);
    emitGameState(roomCode);
    appendLog(roomCode, `Gra rozpoczęta. Pierwszy ruch: ${room.players[room.currentPlayerIndex].nickname}.`);
    callback?.({ ok: true });
    scheduleSave(roomCode);
  });

  socket.on('restartGame', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (socket.id !== room.hostId) return callback?.({ ok: false, error: 'NOT_HOST' });

    resetGame(roomCode);
    callback?.({ ok: true });
    scheduleSave(roomCode);
  });

  socket.on('sendMessage', ({ roomCode, nickname, message }) => {
    io.to(roomCode).emit('newMessage', { nickname, message, timestamp: new Date().toISOString() });
  });

  // Jail choice
  function handleJailChoice({ roomCode, pay }, callback) {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (room.gameOver) return callback?.({ ok: false, error: 'GAME_OVER' });

    ensureCurrentIsActive(room);

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer) return callback?.({ ok: false, error: 'NO_CURRENT_PLAYER' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });
    if (currentPlayer.isBankrupt) return callback?.({ ok: false, error: 'BANKRUPT' });
    if (currentPlayer.isDisconnected) return callback?.({ ok: false, error: 'DISCONNECTED' });

    if (room.phase !== 'awaiting_jail_choice' || !room.pending || room.pending.type !== 'jail' || room.pending.playerId !== socket.id) {
      return callback?.({ ok: false, error: 'NOT_IN_JAIL_CHOICE' });
    }

    const fine = Number(room.pending.fine || JAIL_FINE);

    if (Boolean(pay)) {
      currentPlayer.balance -= fine;
      currentPlayer.inJail = false;
      currentPlayer.jailTurnsLeft = 0;

      appendLog(roomCode, `${currentPlayer.nickname} zapłacił ${fine} i wychodzi z więzienia.`);
      emitToastToPlayer(currentPlayer.id, { type: 'err', text: `Więzienie: -${fine}` });
      emitPaymentPromptToPlayer(currentPlayer.id, { type: 'fee', amount: fine, label: 'Więzienie' });

      room.phase = 'awaiting_roll';
      room.pending = null;

      emitGameState(roomCode);

      if (handleBankruptcy(roomCode, currentPlayer.id)) {
        advanceTurn(room);
        emitGameState(roomCode);
        checkWinner(roomCode);
        scheduleSave(roomCode);
        return callback?.({ ok: true, phase: 'awaiting_roll' });
      }

      scheduleSave(roomCode);
      return callback?.({ ok: true, phase: 'awaiting_roll' });
    }

    currentPlayer.jailTurnsLeft = Math.max(0, Number(currentPlayer.jailTurnsLeft || 0) - 1);
    appendLog(roomCode, `${currentPlayer.nickname} zostaje w więzieniu i pomija turę.`);

    if (currentPlayer.jailTurnsLeft <= 0) {
      currentPlayer.inJail = false;
      appendLog(roomCode, `${currentPlayer.nickname} wychodzi z więzienia.`);
    }

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);
    emitGameState(roomCode);
    scheduleSave(roomCode);
    callback?.({ ok: true, phase: 'awaiting_roll' });
  }

  socket.on('jailChoice', handleJailChoice);
  socket.on('jail_choice', handleJailChoice);

  // Card ack
  function handleCardAck({ roomCode }, callback) {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (room.gameOver) return callback?.({ ok: false, error: 'GAME_OVER' });

    ensureCurrentIsActive(room);

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer) return callback?.({ ok: false, error: 'NO_CURRENT_PLAYER' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });
    if (currentPlayer.isBankrupt) return callback?.({ ok: false, error: 'BANKRUPT' });
    if (currentPlayer.isDisconnected) return callback?.({ ok: false, error: 'DISCONNECTED' });

    if (room.phase !== 'awaiting_card_ack' || !room.pending || room.pending.type !== 'card' || room.pending.playerId !== socket.id) {
      return callback?.({ ok: false, error: 'NOT_IN_CARD_ACK' });
    }

    const pendingCard = safeClone(room.pending);
    room.pending = null;

    const result = applyCardEffectAfterAck(roomCode, room, currentPlayer, pendingCard);
    scheduleSave(roomCode);
    return callback?.({ ok: true, phase: result?.phase || room.phase });
  }

  socket.on('cardAck', handleCardAck);
  socket.on('card_ack', handleCardAck);

  socket.on('rollDice', ({ roomCode }, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'NOT_PLAYING' });
    if (room.gameOver) return callback?.({ ok: false, error: 'GAME_OVER' });

    ensureCurrentIsActive(room);

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer) return callback?.({ ok: false, error: 'NO_CURRENT_PLAYER' });
    if (currentPlayer.isBankrupt) return callback?.({ ok: false, error: 'BANKRUPT' });
    if (currentPlayer.isDisconnected) return callback?.({ ok: false, error: 'DISCONNECTED' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });

    if (room.phase !== 'awaiting_roll') return callback?.({ ok: false, error: 'NOT_IN_ROLL_PHASE' });

    if (currentPlayer.inJail && currentPlayer.jailTurnsLeft > 0) {
      const prompted = maybePromptJail(roomCode, room, currentPlayer);
      if (prompted) return callback?.({ ok: true, phase: 'awaiting_jail_choice' });
    }

    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const steps = dice1 + dice2;

    const oldPos = currentPlayer.position;
    let newPos = oldPos + steps;
    const len = room.board.length;

    if (newPos >= len) {
      newPos = newPos % len;
      currentPlayer.balance += 200;
      appendLog(roomCode, `${currentPlayer.nickname} przeszedł przez START i otrzymał +200.`);
      emitToastToPlayer(currentPlayer.id, { type: 'ok', text: 'START: +200' });
    }

    currentPlayer.position = newPos;
    const tile = room.board[newPos];

    io.to(roomCode).emit('diceRolled', {
      playerId: currentPlayer.id,
      nickname: currentPlayer.nickname,
      dice1,
      dice2,
      steps,
      newPosition: newPos,
      tile,
    });

    const path = buildForwardPath(oldPos, steps, len);
    io.to(roomCode).emit('playerMovePath', { playerId: currentPlayer.id, path, reason: 'dice' });

    appendLog(roomCode, `${currentPlayer.nickname} rzucił ${dice1}+${dice2}=${steps} → ${tile.name}.`);

    const result = resolveLanding(roomCode, room, currentPlayer, steps, false);
    scheduleSave(roomCode);
    return callback?.({ ok: true, phase: result?.phase || room.phase });
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
    if (currentPlayer.isDisconnected) return callback?.({ ok: false, error: 'DISCONNECTED' });
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

    appendLog(roomCode, `${currentPlayer.nickname} kupił ${tile.name} za ${tile.price}.`);
    emitToastToPlayer(currentPlayer.id, { type: 'ok', text: `Kupiono: ${tile.name} (-${tile.price})` });

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);

    emitGameState(roomCode);
    scheduleSave(roomCode);
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
    if (currentPlayer.isDisconnected) return callback?.({ ok: false, error: 'DISCONNECTED' });
    if (currentPlayer.id !== socket.id) return callback?.({ ok: false, error: 'NOT_YOUR_TURN' });

    if (room.phase !== 'awaiting_buy' || !room.pending || room.pending.playerId !== socket.id) {
      return callback?.({ ok: false, error: 'NOT_IN_BUY_PHASE' });
    }

    appendLog(roomCode, `${currentPlayer.nickname} nie kupił pola i kończy turę.`);
    emitToastToPlayer(currentPlayer.id, { type: 'ok', text: 'Pominięto zakup' });

    room.phase = 'awaiting_roll';
    room.pending = null;
    advanceTurn(room);

    emitGameState(roomCode);
    scheduleSave(roomCode);
    callback?.({ ok: true });
  });

  socket.on('disconnect', async () => {
    for (const roomCode of Object.keys(rooms)) {
      const room = rooms[roomCode];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) continue;

      const pl = room.players[idx];

      // WAITING: remove player (classic lobby behavior)
      if (room.status === 'waiting') {
        room.players.splice(idx, 1);
        delete room.readyById[socket.id];

        appendLog(roomCode, `Gracz ${pl.nickname} opuścił pokój.`);

        if (room.players.length === 0) {
          delete rooms[roomCode];
          await deleteRoomFromDb(roomCode);
          return;
        }

        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.readyById[room.hostId] = true;
          appendLog(roomCode, `Nowy host: ${room.players[0].nickname}.`);
        }

        emitRoomUpdate(roomCode);
        scheduleSave(roomCode);
        continue;
      }

      // PLAYING: do NOT remove player, do NOT release properties
      pl.isDisconnected = true;
      pl.disconnectedAt = Date.now();

      appendLog(roomCode, `Gracz ${pl.nickname} rozłączył się (gra trwa dalej).`);

      // If disconnected player was current, advance turn to avoid stuck game
      const current = room.players[room.currentPlayerIndex] || null;
      if (current && current.id === pl.id) {
        room.phase = 'awaiting_roll';
        room.pending = null;
        advanceTurn(room);
        appendLog(roomCode, `Tura została pominięta (gracz rozłączony).`);
      } else {
        ensureCurrentIsActive(room);
      }

      emitRoomUpdate(roomCode);
      emitGameState(roomCode);
      scheduleSave(roomCode);
    }
  });
});

app.get('/', (req, res) => res.send('Monopolista server is running'));

const PORT = process.env.PORT || 4000;

(async () => {
  await connectMongo();
  server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
})();
