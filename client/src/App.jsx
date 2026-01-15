import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER_URL = (() => {
  const viteUrl =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env.VITE_SERVER_URL === 'string'
      ? import.meta.env.VITE_SERVER_URL
      : '';

  const craUrl =
    typeof process !== 'undefined' &&
    process.env &&
    typeof process.env.REACT_APP_SERVER_URL === 'string'
      ? process.env.REACT_APP_SERVER_URL
      : '';

  return (viteUrl || craUrl || 'http://localhost:4000').trim();
})();

const socket = io(SERVER_URL, {
  withCredentials: true,
  autoConnect: true,
});

const TURN_TIMEOUT_MS = 60 * 1000;
const DISCONNECT_GRACE_MS = 90 * 1000;

const COLOR_HEX = {
  blue: '#3B82F6',
  yellow: '#FACC15',
  red: '#EF4444',
  green: '#22C55E',
  pink: '#EC4899',
};

const TILE_LABEL_OVERRIDES = {
  2: 'Kasa\nspołeczna',
  17: 'Kasa\nspołeczna',
  33: 'Kasa\nspołeczna',

  4: 'Podatek\ndochodowy',
  38: 'Domiar\npodatkowy',

  20: 'Bezpłatny\nparking',
  30: 'Idź do\nwięzienia',
  10: 'Więzienie\n/ tylko z\nwizytą',

  5: 'Dworzec\nZachodni',
  15: 'Dworzec\nGdański',
  25: 'Dworzec\nWschodni',
  35: 'Dworzec\nCentralny',
};


function getTileDisplayName(tile) {
  if (!tile) return '';
  return TILE_LABEL_OVERRIDES[tile.id] || String(tile.name || '');
}

function isBuyable(tile) {
  return tile && (tile.type === 'property' || tile.type === 'station' || tile.type === 'utility');
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function countOwnerStations(board, ownerId) {
  return board.filter((t) => t.type === 'station' && t.ownerId === ownerId).length;
}

function countOwnerUtilities(board, ownerId) {
  return board.filter((t) => t.type === 'utility' && t.ownerId === ownerId).length;
}

function countOwnerGroupProps(board, ownerId, group) {
  return board.filter((t) => t.type === 'property' && t.group === group && t.ownerId === ownerId).length;
}

function computeDisplayedRent(tile, board) {
  if (!tile || !tile.ownerId) return null;

  if (tile.type === 'property') {
    const ownedInGroup = countOwnerGroupProps(board, tile.ownerId, tile.group);
    const levels = Array.isArray(tile.rentLevels) ? tile.rentLevels : [];
    if (levels.length === 0) return null;

    const idx = clamp(ownedInGroup, 1, levels.length) - 1;
    const base = Number(levels[idx] || 0);

    const houses = Number(tile.houses || 0);
    const hasHotel = Boolean(tile.hasHotel);

    let rent = base;
    let suffix = '';

    if (hasHotel) {
      rent = Math.max(0, Math.round(base * 6));
      suffix = ' (hotel)';
    } else if (houses > 0) {
      rent = Math.max(0, Math.round(base * (1 + houses)));
      suffix = ` (${houses} dom)`;
    }

    return { mode: 'fixed', text: `Czynsz: ${rent}${suffix}` };
  }

  if (tile.type === 'station') {
    const stations = countOwnerStations(board, tile.ownerId);
    const base = Number(tile.rent || 25);
    const mult = Math.pow(2, clamp(stations, 1, 4) - 1);
    const rent = base * mult;
    return { mode: 'fixed', text: `Czynsz: ${rent}` };
  }

  if (tile.type === 'utility') {
    const utils = countOwnerUtilities(board, tile.ownerId);
    const mult = utils >= 2 ? 10 : 4;
    return { mode: 'dice', text: `Czynsz: kości×${mult}` };
  }

  return null;
}

function makeRange(from, to) {
  const arr = [];
  for (let i = from; i <= to; i += 1) arr.push(i);
  return arr;
}

function formatPaymentTitle(payload) {
  const t = payload?.type;
  if (t === 'rent') return 'Czynsz';
  if (t === 'tax') return 'Podatek';
  return payload?.label || 'Opłata';
}

function formatPaymentBody(payload) {
  const t = payload?.type;
  const amount = Number(payload?.amount || 0);

  if (t === 'rent') {
    const toNick = payload?.toNickname || 'gracz';
    const tileName = payload?.tileName ? ` (${payload.tileName})` : '';
    return `Zapłać czynsz ${amount} dla ${toNick}${tileName}.`;
  }

  if (t === 'tax') {
    const tileName = payload?.tileName ? ` (${payload.tileName})` : '';
    return `Zapłać podatek ${amount}${tileName}.`;
  }

  const label = payload?.label || 'Opłata';
  return `Zapłać ${label}: ${amount}.`;
}

function formatPaymentButton(payload) {
  const t = payload?.type;
  const amount = Number(payload?.amount || 0);
  if (t === 'rent') return `Zapłać czynsz ${amount}`;
  if (t === 'tax') return `Zapłać podatek ${amount}`;
  const label = payload?.label || 'Opłata';
  return `Zapłać ${label} ${amount}`;
}

function safeClipboardCopy(text) {
  try {
    if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(text);
  } catch (e) {}
  return Promise.reject(new Error('Clipboard not available'));
}

function formatTimeLeft(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const totalSeconds = Math.ceil(safe / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTileTypeLabel(tile) {
  if (!tile) return '-';
  if (tile.type === 'property') return 'Nieruchomość';
  if (tile.type === 'station') return 'Dworzec';
  if (tile.type === 'utility') return 'Media';
  return tile.type || '-';
}

function canAfford(balance, price) {
  return Number(balance || 0) >= Number(price || 0);
}

function getUpgradeCostClient(tile) {
  const price = Number(tile?.price || 0);
  return Math.max(50, Math.round(price * 0.5));
}

export default function App() {
  const [screen, setScreen] = useState('home');
  const [showHowTo, setShowHowTo] = useState(false);

  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [loadingRoom, setLoadingRoom] = useState(false);

  const [currentRoom, setCurrentRoom] = useState(null);
  const [roomStatus, setRoomStatus] = useState('idle');
  const [hostId, setHostId] = useState(null);
  const [readyById, setReadyById] = useState({});
  const [players, setPlayers] = useState([]);

  const [activeTab, setActiveTab] = useState('chat');
  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [gameLog, setGameLog] = useState([]);

  const [gameState, setGameState] = useState(null);
  const [diceInfo, setDiceInfo] = useState(null);

  const [socketId, setSocketId] = useState(null);
  const [animatedPositions, setAnimatedPositions] = useState({});

  const animatingRef = useRef({});
  const timersRef = useRef({});
  const delayedPaymentToastsRef = useRef([]);

  const [toast, setToast] = useState(null);

  const [showWinnerModal, setShowWinnerModal] = useState(false);

  const [cardModal, setCardModal] = useState(null);
  const [jailModal, setJailModal] = useState(null);

  const [paymentQueue, setPaymentQueue] = useState([]);
  const paymentModal = paymentQueue.length > 0 ? paymentQueue[0] : null;

  const [buyModalOpen, setBuyModalOpen] = useState(false);
  const [buyModalTileId, setBuyModalTileId] = useState(null);

  const [upgradeModalTileId, setUpgradeModalTileId] = useState(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');

  const [turnDeadlineMs, setTurnDeadlineMs] = useState(null);
  const [turnLeftMs, setTurnLeftMs] = useState(0);
  const lastTurnKeyRef = useRef('');

  const activityScrollRef = useRef(null);
  const stickToBottomRef = useRef(true);

  const isInRoom = Boolean(currentRoom);
  const isPlaying = roomStatus === 'playing';
  const isWaiting = roomStatus === 'waiting';

  function setAnimating(playerId, value) {
    if (!playerId) return;
    if (value) animatingRef.current[playerId] = true;
    else delete animatingRef.current[playerId];
  }

  function isAnimating(playerId) {
    return Boolean(playerId && animatingRef.current[playerId]);
  }

  function stopAnimation(playerId) {
    const entry = timersRef.current[playerId];
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry?.preTimer) clearTimeout(entry.preTimer);
    delete timersRef.current[playerId];
    setAnimating(playerId, false);
  }

  function startAnimation(playerId, path) {
    stopAnimation(playerId);
    if (!Array.isArray(path) || path.length === 0) return;

    setAnimating(playerId, true);

    let idx = 0;
    const stepMs = 180;

    const run = () => {
      const pos = path[idx];
      setAnimatedPositions((prev) => ({ ...prev, [playerId]: pos }));
      idx += 1;

      if (idx >= path.length) {
        stopAnimation(playerId);
        return;
      }

      timersRef.current[playerId] = { ...timersRef.current[playerId], timer: setTimeout(run, stepMs) };
    };

    timersRef.current[playerId] = { ...timersRef.current[playerId], timer: setTimeout(run, stepMs) };
  }

  function markPreAnimation(playerId) {
    if (!playerId) return;
    setAnimating(playerId, true);
    const preTimer = setTimeout(() => stopAnimation(playerId), 2200);
    timersRef.current[playerId] = { ...timersRef.current[playerId], preTimer };
  }

  const isHost = Boolean(socketId && hostId && socketId === hostId);
  const iAmReady = Boolean(socketId && readyById?.[socketId] === true);

  const allReady = useMemo(() => {
    if (!players || players.length < 2) return false;
    return players.every((p) => readyById?.[p.id] === true);
  }, [players, readyById]);

  const ownerColorMap = useMemo(() => {
    const map = {};
    const list = gameState?.players?.length ? gameState.players : players;
    (list || []).forEach((p) => {
      map[p.id] = p.colorKey || 'blue';
    });
    return map;
  }, [gameState, players]);

  const me = useMemo(() => {
    return gameState?.players?.find((p) => p.id === socketId) || null;
  }, [gameState, socketId]);

  const gameOver = Boolean(gameState?.gameOver);
  const winner = gameState?.winner || null;

  const isMyTurn = Boolean(gameState?.currentPlayerId && socketId && gameState.currentPlayerId === socketId);
  const currentPlayer = gameState?.players?.find((p) => p.id === gameState?.currentPlayerId) || null;

  const isMeBankrupt = Boolean(me?.isBankrupt);
  const isMeAnimating = Boolean(socketId && animatingRef.current[socketId]);

  const board = Array.isArray(gameState?.board) ? gameState.board : [];
  const getTile = (id) => board[id] || null;
  useEffect(() => {
    const el = activityScrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const threshold = 40;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
      stickToBottomRef.current = atBottom;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => el.removeEventListener('scroll', onScroll);
  }, [activeTab]);

  useEffect(() => {
    const el = activityScrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, gameLog, activeTab]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!turnDeadlineMs) {
        setTurnLeftMs(0);
        return;
      }
      setTurnLeftMs(Math.max(0, turnDeadlineMs - Date.now()));
    }, 250);
    return () => clearInterval(id);
  }, [turnDeadlineMs]);

  useEffect(() => {
    if (!gameState || !socketId) {
      setBuyModalOpen(false);
      setBuyModalTileId(null);
      return;
    }

    const shouldOpen =
      !gameState.gameOver &&
      gameState.phase === 'awaiting_buy' &&
      gameState.pending?.playerId === socketId &&
      typeof gameState.pending?.tileId === 'number';

    if (shouldOpen) {
      setBuyModalTileId(gameState.pending.tileId);
      setBuyModalOpen(true);
    } else {
      setBuyModalOpen(false);
      setBuyModalTileId(null);
    }
  }, [gameState, socketId]);

  useEffect(() => {
    if (!upgradeModalTileId) return;
    if (!gameState || gameOver || !isMyTurn || gameState.phase !== 'awaiting_roll') {
      setUpgradeModalTileId(null);
      setUpgradeLoading(false);
      setUpgradeError('');
      return;
    }
    if (isMeAnimating) {
      setUpgradeModalTileId(null);
      setUpgradeLoading(false);
      setUpgradeError('');
    }
  }, [upgradeModalTileId, gameState, gameOver, isMyTurn, isMeAnimating]);

  useEffect(() => {
    if (gameOver) setShowWinnerModal(true);
  }, [gameOver]);

  useEffect(() => {
    if (!jailModal) return;
    if (gameOver) setJailModal(null);
  }, [jailModal, gameOver]);

  useEffect(() => {
    if (isPlaying) setScreen('game');
  }, [isPlaying]);

  useEffect(() => {
    const updateSocketId = () => setSocketId(socket.id || null);
    updateSocketId();

    const onRoomUpdate = (payload) => {
      setRoomStatus(payload.status || 'waiting');
      setHostId(payload.hostId || null);
      setReadyById(payload.readyById || {});
      setPlayers(payload.players || []);
    };

    const onNewMessage = (msg) => setMessages((prev) => [...prev, msg]);
    const onGameLogEvent = (entry) => setGameLog((prev) => [...prev, entry]);

    const onLogHistory = (entries) => {
      const list = Array.isArray(entries) ? entries : [];
      setGameLog(list);
    };

    const onGameReset = () => {
      setGameLog([]);
      setDiceInfo(null);
      setShowWinnerModal(false);
      setCardModal(null);
      setJailModal(null);
      setPaymentQueue([]);
      delayedPaymentToastsRef.current = [];
      setAnimatedPositions({});
      setToast({ type: 'ok', text: 'Nowa gra' });
      setTimeout(() => setToast(null), 1600);

      setBuyModalOpen(false);
      setBuyModalTileId(null);
      setUpgradeModalTileId(null);
      setUpgradeLoading(false);
      setUpgradeError('');

      setTurnDeadlineMs(null);
      setTurnLeftMs(0);
      lastTurnKeyRef.current = '';
    };

    const tryRestoreBlockingModalsFromState = (state) => {
      const myId = socket.id || null;
      if (!myId) return;

      if (state?.gameOver) {
        setCardModal(null);
        setJailModal(null);
        return;
      }

      if (state?.phase === 'awaiting_card_ack' && state?.pending?.type === 'card') {
        if (state.pending.playerId === myId) {
          const pendingCard = state.pending.card || null;
          const deckLabel =
            state.pending.deckLabel || (state.pending.deckType === 'chance' ? 'Szansa' : 'Kasa społeczna');
          const text = pendingCard?.text || state.pending?.card?.text || '';
          const mePl = (state.players || []).find((p) => p.id === myId) || null;

          setCardModal((prev) => {
            if (prev && String(prev.text || '') === String(text || '')) return prev;
            return {
              deckLabel,
              text: String(text || ''),
              nickname: mePl?.nickname || null,
              colorKey: mePl?.colorKey || 'blue',
            };
          });
        }
      } else {
        setCardModal((prev) => (prev ? null : prev));
      }

      if (state?.phase === 'awaiting_jail_choice' && state?.pending?.type === 'jail') {
        if (state.pending.playerId === myId) {
          const fine = typeof state.pending.fine === 'number' ? state.pending.fine : 50;
          setJailModal({ fine });
        }
      } else {
        setJailModal((prev) => (prev ? null : prev));
      }
    };

    const maybeStartTurnTimerUi = (state) => {
      if (!state || state.status !== 'playing' || state.gameOver) {
        setTurnDeadlineMs(null);
        setTurnLeftMs(0);
        lastTurnKeyRef.current = '';
        return;
      }

      const currentId = state.currentPlayerId || '';
      const currentPl = (state.players || []).find((p) => p.id === currentId) || null;
      const isDisc = Boolean(currentPl?.isDisconnected);
      const key = `${currentId}|${isDisc ? 'D' : 'C'}`;

      if (key && key !== lastTurnKeyRef.current) {
        lastTurnKeyRef.current = key;
        const duration = isDisc ? DISCONNECT_GRACE_MS : TURN_TIMEOUT_MS;
        setTurnDeadlineMs(Date.now() + duration);
      }
    };

    const onGameState = (state) => {
      setGameState(state);

      setAnimatedPositions((prev) => {
        const next = { ...prev };
        (state.players || []).forEach((pl) => {
          if (!isAnimating(pl.id)) next[pl.id] = pl.position;
          else if (next[pl.id] === undefined || next[pl.id] === null) next[pl.id] = pl.position;
        });
        return next;
      });

      tryRestoreBlockingModalsFromState(state);
      maybeStartTurnTimerUi(state);

      if (state?.status === 'playing') setScreen('game');
    };

    const onDiceRolled = (info) => {
      setDiceInfo(info);
      markPreAnimation(info?.playerId);
    };

    const onPlayerMovePath = (payload) => {
      if (!payload || !payload.playerId) return;
      const path = Array.isArray(payload.path) ? payload.path : [];

      const entry = timersRef.current[payload.playerId];
      if (entry?.preTimer) clearTimeout(entry.preTimer);
      timersRef.current[payload.playerId] = { ...entry, preTimer: null };

      startAnimation(payload.playerId, path);
    };

    const onToast = (payload) => {
      if (!payload || !payload.text) return;

      const text = String(payload.text || '');
      const isRentPayerToast = text.startsWith('Czynsz: -');
      const isTaxToast = text.startsWith('Podatek:');

      if (isRentPayerToast || isTaxToast) {
        delayedPaymentToastsRef.current.push({
          type: payload.type === 'ok' ? 'ok' : 'err',
          text,
        });
        return;
      }

      setToast({ type: payload.type === 'ok' ? 'ok' : 'err', text });
      setTimeout(() => setToast(null), 2200);
    };

    const onCardDrawn = (payload) => {
      if (!payload) return;
      setCardModal({
        deckLabel: payload.deckLabel || (payload.deckType === 'chance' ? 'Szansa' : 'Kasa społeczna'),
        text: String(payload.text || ''),
        nickname: payload.nickname || null,
        colorKey: payload.colorKey || 'blue',
      });
    };

    const onJailPrompt = (payload) => {
      if (!payload) return;
      if (payload.playerId && socket.id && payload.playerId !== socket.id) return;
      const fine = typeof payload.fine === 'number' ? payload.fine : 50;
      setJailModal({ fine });
    };

    const onPaymentPrompt = (payload) => {
      if (!payload) return;
      setPaymentQueue((prev) => [...prev, payload]);
    };

    socket.on('connect', updateSocketId);
    socket.on('reconnect', updateSocketId);
    socket.on('disconnect', () => setSocketId(null));

    socket.on('roomUpdate', onRoomUpdate);
    socket.on('newMessage', onNewMessage);
    socket.on('gameLogEvent', onGameLogEvent);
    socket.on('logHistory', onLogHistory);
    socket.on('gameReset', onGameReset);
    socket.on('gameState', onGameState);
    socket.on('diceRolled', onDiceRolled);
    socket.on('playerMovePath', onPlayerMovePath);
    socket.on('toast', onToast);

    socket.on('cardDrawn', onCardDrawn);
    socket.on('jailPrompt', onJailPrompt);
    socket.on('paymentPrompt', onPaymentPrompt);

    return () => {
      socket.off('connect', updateSocketId);
      socket.off('reconnect', updateSocketId);
      socket.off('disconnect');

      socket.off('roomUpdate', onRoomUpdate);
      socket.off('newMessage', onNewMessage);
      socket.off('gameLogEvent', onGameLogEvent);
      socket.off('logHistory', onLogHistory);
      socket.off('gameReset', onGameReset);
      socket.off('gameState', onGameState);
      socket.off('diceRolled', onDiceRolled);
      socket.off('playerMovePath', onPlayerMovePath);
      socket.off('toast', onToast);

      socket.off('cardDrawn', onCardDrawn);
      socket.off('jailPrompt', onJailPrompt);
      socket.off('paymentPrompt', onPaymentPrompt);
    };
  }, []);

  const resetUiForLobby = () => {
    setMessages([]);
    setGameLog([]);
    setActiveTab('chat');
    setGameState(null);
    setDiceInfo(null);
    setAnimatedPositions({});
    setToast(null);
    setShowWinnerModal(false);
    setCardModal(null);
    setJailModal(null);
    setPaymentQueue([]);
    delayedPaymentToastsRef.current = [];
    setBuyModalOpen(false);
    setBuyModalTileId(null);
    setUpgradeModalTileId(null);
    setUpgradeLoading(false);
    setUpgradeError('');

    setTurnDeadlineMs(null);
    setTurnLeftMs(0);
    lastTurnKeyRef.current = '';
  };
  const handleCreateRoom = () => {
    if (!nickname.trim()) return setError('Podaj swój nick');
    setError('');
    setLoadingRoom(true);

    socket.emit('createRoom', { nickname }, (res) => {
      setLoadingRoom(false);
      if (!res?.ok) return setError('Nie można utworzyć pokoju');

      setCurrentRoom(res.roomCode);

      if (res.room) {
        setRoomStatus(res.room.status);
        setHostId(res.room.hostId);
        setReadyById(res.room.readyById);
        setPlayers(res.room.players);
      } else {
        setRoomStatus('waiting');
      }

      resetUiForLobby();
      setScreen('lobby');
    });
  };

  const handleJoinRoom = () => {
    if (!nickname.trim()) return setError('Podaj swój nick');
    if (!roomCode.trim()) return setError('Podaj kod pokoju');
    setError('');
    setLoadingRoom(true);

    socket.emit('joinRoom', { roomCode, nickname }, (res) => {
      setLoadingRoom(false);
      if (!res?.ok) {
        const map = {
          ROOM_NOT_FOUND: 'Pokój nie został znaleziony',
          ROOM_FULL: 'Pokój jest pełny',
          GAME_ALREADY_STARTED: 'Gra już się rozpoczęła',
          NICKNAME_TAKEN: 'Nick jest już zajęty',
          SERVER_ERROR: 'Błąd serwera',
        };
        return setError(map[res?.error] || 'Nie można dołączyć do pokoju');
      }

      setCurrentRoom(res.roomCode);

      if (res.room) {
        setRoomStatus(res.room.status);
        setHostId(res.room.hostId);
        setReadyById(res.room.readyById);
        setPlayers(res.room.players);
      } else {
        setRoomStatus('waiting');
      }

      resetUiForLobby();
      setScreen(res.room?.status === 'playing' ? 'game' : 'lobby');
    });
  };

  const handleToggleReady = () => {
    if (!currentRoom) return;
    socket.emit('setReady', { roomCode: currentRoom, ready: !iAmReady });
  };

  const handleStartGame = () => {
    if (!currentRoom) return;
    socket.emit('startGame', { roomCode: currentRoom });
  };

  const handleRestartGame = () => {
    if (!currentRoom) return;
    socket.emit('restartGame', { roomCode: currentRoom });
  };

  const handleRollDice = () => {
    if (!currentRoom) return;
    socket.emit('rollDice', { roomCode: currentRoom }, (res) => {
      if (!res?.ok) {
        setToast({ type: 'err', text: 'Nie można wykonać ruchu.' });
        setTimeout(() => setToast(null), 2000);
      }
    });
  };

  const handleSendMessage = () => {
    if (!messageText.trim() || !currentRoom) return;
    socket.emit('sendMessage', { roomCode: currentRoom, nickname, message: messageText.trim() });
    setMessageText('');
  };

  const handleJailPay = () => {
    if (!currentRoom) return;
    socket.emit('jailChoice', { roomCode: currentRoom, pay: true });
    setJailModal(null);
  };

  const handleJailSkip = () => {
    if (!currentRoom) return;
    socket.emit('jailChoice', { roomCode: currentRoom, pay: false });
    setJailModal(null);
  };

  const handleCardOk = () => {
    if (!currentRoom) return;
    setCardModal(null);
    socket.emit('cardAck', { roomCode: currentRoom });
  };

  const handlePaymentOk = () => {
    setPaymentQueue((prev) => prev.slice(1));

    const next = delayedPaymentToastsRef.current.shift();
    if (next?.text) {
      setToast({ type: next.type === 'ok' ? 'ok' : 'err', text: next.text });
      setTimeout(() => setToast(null), 2200);
    }
  };

  const handleBuyConfirm = () => {
    if (!currentRoom) return;
    socket.emit('buyTile', { roomCode: currentRoom }, () => {});
    setBuyModalOpen(false);
  };

  const handleBuySkip = () => {
    if (!currentRoom) return;
    socket.emit('skipBuy', { roomCode: currentRoom }, () => {});
    setBuyModalOpen(false);
  };

  const handleCopyRoomCode = async () => {
    if (!currentRoom) return;
    try {
      await safeClipboardCopy(String(currentRoom));
      setToast({ type: 'ok', text: 'Skopiowano kod pokoju' });
      setTimeout(() => setToast(null), 1600);
    } catch (e) {
      setToast({ type: 'err', text: 'Nie można skopiować' });
      setTimeout(() => setToast(null), 1800);
    }
  };

  function hasMonopolyClient(tile) {
    if (!tile || tile.type !== 'property') return false;
    const setSize = Number(tile.setSize || 0);
    if (!setSize || !tile.group || !socketId) return false;
    const owned = countOwnerGroupProps(board, socketId, tile.group);
    return owned >= setSize;
  }

  const canOpenUpgrade =
    !gameOver &&
    isMyTurn &&
    !isMeBankrupt &&
    !isMeAnimating &&
    !cardModal &&
    !jailModal &&
    !paymentModal &&
    !buyModalOpen &&
    gameState?.phase === 'awaiting_roll';

  const handleOpenUpgradeFromTile = (tile) => {
    if (!tile) return;
    if (!canOpenUpgrade) return;
    if (tile.type !== 'property') return;
    if (tile.ownerId !== socketId) return;
    if (!hasMonopolyClient(tile)) return;

    setUpgradeError('');
    setUpgradeLoading(false);
    setUpgradeModalTileId(tile.id);
  };

  const upgradeTile = upgradeModalTileId !== null ? getTile(upgradeModalTileId) : null;
  const upgradeCost = upgradeTile ? getUpgradeCostClient(upgradeTile) : 0;
  const upgradeHasHotel = Boolean(upgradeTile?.hasHotel);
  const upgradeHouses = Number(upgradeTile?.houses || 0);
  const upgradeActionLabel = upgradeHasHotel
    ? 'Maksimum'
    : upgradeHouses < 4
    ? `Kup domek (${upgradeHouses + 1}/4)`
    : 'Kup hotel';

  const handleUpgradeConfirm = () => {
    if (!currentRoom || !upgradeTile) return;

    setUpgradeLoading(true);
    setUpgradeError('');

    const timeout = setTimeout(() => {
      setUpgradeLoading(false);
      setUpgradeError('Brak odpowiedzi z serwera. Spróbuj ponownie.');
    }, 3500);

    socket.emit('upgradeTile', { roomCode: currentRoom, tileId: upgradeTile.id }, (res) => {
      clearTimeout(timeout);

      if (res?.ok) {
        setUpgradeLoading(false);
        setUpgradeError('');
        setUpgradeModalTileId(null);
        return;
      }

      const map = {
        NOT_PLAYING: 'Gra nie jest aktywna.',
        GAME_OVER: 'Gra zakończona.',
        NOT_YOUR_TURN: 'To nie twoja tura.',
        DISCONNECTED: 'Jesteś rozłączony.',
        BANKRUPT: 'Jesteś bankrutem.',
        NOT_IN_UPGRADE_PHASE: 'Ulepszenia tylko przed rzutem kośćmi.',
        TILE_NOT_FOUND: 'Nie znaleziono pola.',
        NOT_PROPERTY: 'To nie jest nieruchomość.',
        NOT_OWNER: 'Nie jesteś właścicielem.',
        NO_MONOPOLY: 'Brak pełnego seta (monopolii).',
        NO_MONEY: 'Brak pieniędzy.',
        ALREADY_HOTEL: 'Hotel już istnieje.',
      };

      setUpgradeLoading(false);
      setUpgradeError(map[res?.error] || 'Nie można wykonać ulepszenia.');
    });
  };

  const buyTile = typeof buyModalTileId === 'number' ? getTile(buyModalTileId) : null;
  const meBalance = Number(me?.balance || 0);
  const buyPrice = Number(buyTile?.price || 0);
  const buyAfter = meBalance - buyPrice;

  const groupInfo = useMemo(() => {
    if (!buyTile || buyTile.type !== 'property') return null;
    const group = buyTile.group || '-';
    const setSize = Number(buyTile.setSize || 0) || 0;
    const ownedInGroup = countOwnerGroupProps(board, socketId, group);
    const afterOwned = ownedInGroup + 1;
    const missing = Math.max(0, setSize - afterOwned);
    return { group, setSize, ownedInGroup, afterOwned, missing };
  }, [buyTile, board, socketId]);

  const tl = getTile(20);
  const tr = getTile(30);
  const bl = getTile(10);
  const br = getTile(0);

  const topEdgeIds = makeRange(21, 29);
  const bottomEdgeIds = makeRange(1, 9).reverse();
  const leftEdgeIds = makeRange(11, 19).reverse();
  const rightEdgeIds = makeRange(31, 39);

  const currentTurnTimerText = useMemo(() => {
    if (!isPlaying || gameOver) return '';
    if (!currentPlayer?.id) return '';
    return formatTimeLeft(turnLeftMs);
  }, [isPlaying, gameOver, currentPlayer, turnLeftMs]);

  const winnerId = winner?.id || null;

  const winnerPlayers = useMemo(() => {
    const list = Array.isArray(gameState?.players) ? [...gameState.players] : [];
    list.sort((a, b) => {
      const aW = winnerId && a.id === winnerId ? 1 : 0;
      const bW = winnerId && b.id === winnerId ? 1 : 0;
      if (aW !== bW) return bW - aW;

      const aActive = a.isBankrupt ? 0 : 1;
      const bActive = b.isBankrupt ? 0 : 1;
      if (aActive !== bActive) return bActive - aActive;

      return Number(b.balance || 0) - Number(a.balance || 0);
    });
    return list;
  }, [gameState, winnerId]);

  const summaryCounts = useMemo(() => {
    const list = winnerPlayers;
    const total = list.length;
    const bankrupt = list.filter((p) => p.isBankrupt).length;
    const offline = list.filter((p) => p.isDisconnected && !p.isBankrupt).length;
    return { total, bankrupt, offline };
  }, [winnerPlayers]);

  const getPlayerStatusLabel = (p) => {
    if (p?.isBankrupt) return 'BANKRUT';
    if (p?.isDisconnected) return 'OFFLINE';
    if (p?.inJail) return 'WIĘZIENIE';
    return 'AKTYWNY';
  };

  const renderTile = (tile, side, extraClass = '') => {
    if (!tile) return null;

    const ownerColorKey = tile.ownerId ? ownerColorMap[tile.ownerId] || 'blue' : null;
    const ownedClass = ownerColorKey ? `owned--${ownerColorKey}` : '';
    const typeClass = `board-tile--${tile.type || 'property'}`;

    const clickableUpgrade =
      canOpenUpgrade &&
      tile.type === 'property' &&
      tile.ownerId === socketId &&
      hasMonopolyClient(tile);

    const tileClass = [
      'board-tile',
      typeClass,
      ownedClass,
      `price-in-${side}`,
      `token-out-${side}`,
      `tile-side--${side}`,
      extraClass,
    ]
      .filter(Boolean)
      .join(' ');

    let badgeText = '';

    if (tile.type === 'tax' && typeof tile.amount === 'number') {
      badgeText = `Podatek: ${tile.amount}`;
    } else if (isBuyable(tile) && typeof tile.price === 'number') {
      if (tile.ownerId) {
        const rentInfo = computeDisplayedRent(tile, board);
        badgeText = rentInfo?.text || 'Czynsz: -';
      } else {
        badgeText = `Cena: ${tile.price}`;
      }
    }

    const playersOnTile = (gameState?.players || []).filter(
      (p) => (animatedPositions[p.id] ?? p.position) === tile.id
    );

    const houses = Number(tile.houses || 0);
    const hasHotel = Boolean(tile.hasHotel);
    const showUpgrades = tile.type === 'property' && (houses > 0 || hasHotel);

    return (
      <div
        className={tileClass}
        title={clickableUpgrade ? `${tile.name} (kliknij: ulepszenia)` : tile.name}
        onClick={() => {
          if (clickableUpgrade) handleOpenUpgradeFromTile(tile);
        }}
        style={clickableUpgrade ? { cursor: 'pointer' } : undefined}
      >
        {badgeText && <div className="price-badge">{badgeText}</div>}

        {showUpgrades && (
          <div
            style={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              zIndex: 30,
              fontSize: 12,
              fontWeight: 950,
              opacity: 0.95,
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              pointerEvents: 'none',
              background: 'rgba(2,6,23,0.65)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 10,
              padding: '3px 6px',
            }}
          >
            {hasHotel ? (
              <>
                <span style={{ fontSize: 13 }}>🏨</span>
                <span>Hotel</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 13 }}>🏠</span>
                <span>{houses}/4</span>
              </>
            )}
          </div>
        )}

        <div className="tile-top">
          <div className="tile-name">
             {getTileDisplayName(tile).split('\n').map((part, idx, arr) => (
              <React.Fragment key={idx}>
                {part}
                {idx < arr.length - 1 ? <br /> : null}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="tile-tokens">
          {playersOnTile.map((p) => (
            <div
              key={p.id}
              className="player-token"
              title={p.nickname}
              style={{ background: COLOR_HEX[p.colorKey || 'blue'] || '#94a3b8' }}
            >
              {p.nickname?.[0]?.toUpperCase() || '?'}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const currentTurnTimerTextMemo = useMemo(() => {
    if (!isPlaying || gameOver) return '';
    if (!currentPlayer?.id) return '';
    return formatTimeLeft(turnLeftMs);
  }, [isPlaying, gameOver, currentPlayer, turnLeftMs]);

  return (
    <div className="app">
      <div className="card">
        {!isPlaying && (
          <div className="menu-shell">
            <div className="menu-card">
              {screen === 'home' && (
                <>
                  <div className="menu-title">Monopolista</div>
                  <div className="menu-sub">Multiplayer • Socket.IO • Monopoly-like</div>

                  <div className="menu-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <button type="button" onClick={() => setScreen('lobby')} style={{ width: '100%' }}>
                      Nowa gra
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowHowTo(true)}
                      style={{ background: '#334155', width: '100%' }}
                    >
                      Jak grać
                    </button>
                  </div>

                  <div className="menu-footer">
                    <div className="muted" style={{ fontSize: 12 }}>
                      Server: <span style={{ opacity: 0.9 }}>{SERVER_URL}</span>
                    </div>
                  </div>
                </>
              )}

              {screen === 'lobby' && (
                <>
                  <div className="menu-topbar">
                    <button
                      type="button"
                      onClick={() => setScreen('home')}
                      className="menu-back"
                      style={{ background: '#334155' }}
                    >
                      ← Wróć
                    </button>
                    <div className="menu-topbar-title">Monopolista</div>
                    <div style={{ width: 76 }} />
                  </div>

                  <div className="menu-section">
                    <label>
                      Nick:
                      <input
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        placeholder="Wpisz nick..."
                      />
                    </label>

                    {!isInRoom && (
                      <>
                        <label>
                          Kod pokoju:
                          <input
                            value={roomCode}
                            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                            placeholder="Wpisz kod"
                          />
                        </label>

                        {error && <div style={{ color: '#f97373', marginTop: 8, fontSize: 13 }}>{error}</div>}

                        <div className="menu-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                          <button
                            onClick={handleCreateRoom}
                            disabled={loadingRoom}
                            type="button"
                            style={{ width: '100%' }}
                          >
                            {loadingRoom ? 'Tworzenie...' : 'Stwórz pokój'}
                          </button>

                          <button
                            onClick={handleJoinRoom}
                            disabled={loadingRoom}
                            style={{ background: '#334155', width: '100%' }}
                            type="button"
                          >
                            {loadingRoom ? 'Dołączanie...' : 'Dołącz do pokoju'}
                          </button>

                          <button
                            type="button"
                            onClick={() => setShowHowTo(true)}
                            style={{ background: 'rgba(148,163,184,0.18)', width: '100%' }}
                          >
                            Jak grać
                          </button>
                        </div>
                      </>
                    )}

                    {isInRoom && isWaiting && (
                      <div className="lobby-box" style={{ marginTop: 14 }}>
                        <div className="lobby-title">
                          Pokój: <strong>{currentRoom}</strong>
                        </div>

                        <div
                          className="menu-actions"
                          style={{ marginTop: 10, flexDirection: 'column', alignItems: 'stretch' }}
                        >
                          <button type="button" onClick={handleCopyRoomCode} style={{ width: '100%', marginTop: 0 }}>
                            Kopiuj kod
                          </button>
                        </div>

                        <div className="lobby-sub" style={{ marginTop: 10 }}>
                          Wszyscy ustawiają status <strong>GOTOWY</strong> (minimum 2 graczy). Host uruchamia grę.
                        </div>

                        <div className="lobby-players">
                          {players.map((p) => (
                            <div key={p.id} className="lobby-player">
                              <span className="badge">{p.id === hostId ? 'HOST' : 'GRACZ'}</span>
                              <span className="name">{p.nickname}</span>
                              <span className={'ready ' + (readyById?.[p.id] ? 'ready-yes' : 'ready-no')}>
                                {readyById?.[p.id] ? 'GOTOWY' : 'NIEGOTOWY'}
                              </span>
                            </div>
                          ))}
                        </div>

                        <div className="lobby-actions">
                          {!isHost && (
                            <button type="button" onClick={handleToggleReady}>
                              {iAmReady ? 'Nie gotowy' : 'Gotowy'}
                            </button>
                          )}
                          {isHost && (
                            <button type="button" onClick={handleStartGame} disabled={!allReady}>
                              Rozpocznij grę
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {showHowTo && (
              <div className="modal-overlay" role="dialog" aria-modal="true">
                <div className="modal-card">
                  <div className="modal-title">Jak grać</div>
                  <div className="modal-body" style={{ textAlign: 'left' }}>
                    <div className="muted" style={{ lineHeight: 1.55 }}>
                      • 60s na turę (auto-akcja po czasie).<br />
                      • 90s na reconnect jeśli gracz jest offline w swojej turze.<br />
                      • 3 pominięte tury offline → forfeit/bankrut.
                    </div>
                  </div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      onClick={() => setShowHowTo(false)}
                      style={{ background: '#334155', width: 'auto', padding: '10px 14px', marginTop: 0 }}
                    >
                      Zamknij
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {isPlaying && gameState && (
          <div className="game-shell">
            {upgradeTile && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(720px, 100%)', textAlign: 'left' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div className="modal-title" style={{ margin: 0, textAlign: 'left' }}>
                        Ulepszenia: {upgradeTile.name}
                      </div>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
                        Pełny set (monopolia). Ulepszenia tylko przed rzutem kośćmi.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setUpgradeModalTileId(null);
                        setUpgradeLoading(false);
                        setUpgradeError('');
                      }}
                      style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}
                    >
                      Zamknij
                    </button>
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      borderRadius: 14,
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: 'rgba(3,7,18,0.55)',
                      padding: 12,
                    }}
                  >
                    <div className="muted" style={{ fontSize: 12 }}>
                      Stan: <strong>{upgradeHasHotel ? 'Hotel' : `Domki ${upgradeHouses}/4`}</strong> • Koszt:{' '}
                      <strong>{upgradeCost}</strong>
                    </div>

                    {upgradeError && <div style={{ marginTop: 10, color: '#f87171', fontSize: 13 }}>{upgradeError}</div>}
                  </div>

                  <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setUpgradeModalTileId(null);
                        setUpgradeLoading(false);
                        setUpgradeError('');
                      }}
                      style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}
                      disabled={upgradeLoading}
                    >
                      Anuluj
                    </button>

                    <button
                      type="button"
                      onClick={handleUpgradeConfirm}
                      disabled={upgradeLoading || upgradeHasHotel || !canAfford(meBalance, upgradeCost)}
                      style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}
                    >
                      {upgradeLoading ? 'Kupuję...' : upgradeActionLabel}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {paymentModal && !cardModal && !jailModal && !buyModalOpen && !upgradeTile && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(620px, 100%)' }}>
                  <div className="modal-title">{formatPaymentTitle(paymentModal)}</div>
                  <div className="modal-body">{formatPaymentBody(paymentModal)}</div>
                  <div className="modal-actions">
                    <button type="button" onClick={handlePaymentOk} style={{ width: 'auto', padding: '10px 18px', marginTop: 0 }}>
                      {formatPaymentButton(paymentModal)}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {buyModalOpen && buyTile && !upgradeTile && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(720px, 100%)', textAlign: 'left' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div className="modal-title" style={{ margin: 0, textAlign: 'left' }}>
                        Kupić pole?
                      </div>
                      <div className="muted" style={{ marginTop: 6 }}>
                        Decyzja dotyczy bieżącego pola. Jeśli pominiesz, zakup przepada.
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 950,
                        padding: '4px 8px',
                        borderRadius: 999,
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(148,163,184,0.10)',
                        opacity: 0.95,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatTileTypeLabel(buyTile)}
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      borderRadius: 14,
                      border: '1px solid rgba(255,255,255,0.10)',
                      background: 'rgba(3,7,18,0.55)',
                      padding: 12,
                    }}
                  >
                    <div style={{ fontWeight: 950, fontSize: 16 }}>{buyTile.name}</div>

                    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(2,6,23,0.55)', padding: 10 }}>
                        <div className="muted" style={{ fontSize: 12 }}>Cena zakupu</div>
                        <div style={{ marginTop: 4, fontWeight: 950, fontSize: 18 }}>{buyPrice}</div>
                      </div>

                      <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(2,6,23,0.55)', padding: 10 }}>
                        <div className="muted" style={{ fontSize: 12 }}>Saldo (teraz → po zakupie)</div>
                        <div style={{ marginTop: 4, fontWeight: 950, fontSize: 16 }}>
                          {meBalance} →{' '}
                          <span style={{ color: canAfford(meBalance, buyPrice) ? '#e5e7eb' : '#f87171' }}>
                            {buyAfter}
                          </span>
                        </div>
                      </div>
                    </div>

                    {buyTile.type === 'property' && groupInfo && (
                      <div style={{ marginTop: 10 }}>
                        <div className="muted" style={{ fontSize: 12 }}>
                          Grupa: <strong style={{ opacity: 0.95 }}>{groupInfo.group}</strong> • Set: {groupInfo.setSize}
                        </div>
                        <div className="muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
                          Masz w tej grupie: <strong style={{ opacity: 0.95 }}>{groupInfo.ownedInGroup}</strong> → po zakupie:{' '}
                          <strong style={{ opacity: 0.95 }}>{groupInfo.afterOwned}</strong>.
                          {groupInfo.missing === 0 ? (
                            <span style={{ marginLeft: 6, color: '#34d399' }}>To będzie pełny set!</span>
                          ) : (
                            <span style={{ marginLeft: 6 }}>
                              Brakuje jeszcze: <strong style={{ opacity: 0.95 }}>{groupInfo.missing}</strong>.
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                    <button type="button" onClick={handleBuySkip} style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}>
                      Pomiń zakup
                    </button>
                    <button type="button" onClick={handleBuyConfirm} disabled={!canAfford(meBalance, buyPrice)} style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}>
                      Kup za {buyPrice}
                    </button>
                  </div>

                  {!canAfford(meBalance, buyPrice) && (
                    <div style={{ marginTop: 10, color: '#f87171', fontSize: 13 }}>
                      Nie masz wystarczająco pieniędzy, aby kupić to pole.
                    </div>
                  )}
                </div>
              </div>
            )}

            {cardModal && !upgradeTile && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9998 }}>
                <div className="modal-card" style={{ width: 'min(620px, 100%)' }}>
                  <div className="modal-title">{cardModal.deckLabel || 'Karta'}</div>
                  <div className="modal-body">{cardModal.text}</div>
                  <div className="modal-actions">
                    <button type="button" onClick={handleCardOk} style={{ width: 'auto', padding: '10px 18px', marginTop: 0 }}>
                      OK
                    </button>
                  </div>
                </div>
              </div>
            )}

            {jailModal && !upgradeTile && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(680px, 100%)' }}>
                  <div className="modal-title">Więzienie</div>
                  <div className="modal-body">
                    Wybierz opcję:
                    <div className="muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
                      • Zapłać <strong>{jailModal.fine}</strong> i wyjdź z więzienia<br />
                      • Pomiń turę
                    </div>
                  </div>
                  <div className="modal-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <button type="button" onClick={handleJailPay} style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}>
                      Zapłać {jailModal.fine}
                    </button>
                    <button type="button" onClick={handleJailSkip} style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}>
                      Pomiń turę
                    </button>
                  </div>
                </div>
              </div>
            )}

            {gameOver && showWinnerModal && (
              <div className="modal-overlay" style={{ zIndex: 9997 }}>
                <div className="modal-card" style={{ width: 'min(620px, 100%)', textAlign: 'left' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div className="modal-title" style={{ margin: 0 }}>
                      {winner ? `Zwycięzca: ${winner.nickname}` : 'Koniec gry'}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowWinnerModal(false)}
                      style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}
                    >
                      Zamknij
                    </button>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(2,6,23,0.55)', padding: 10 }}>
                        <div className="muted" style={{ fontSize: 12 }}>Podsumowanie gry</div>
                        <div style={{ marginTop: 6, fontWeight: 900, fontSize: 13 }}>
                          Gracze: {summaryCounts.total} • Bankruci: {summaryCounts.bankrupt} • Offline: {summaryCounts.offline}
                        </div>
                      </div>

                      <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(2,6,23,0.55)', padding: 10 }}>
                        <div className="muted" style={{ fontSize: 12 }}>Akcja</div>
                        <div style={{ marginTop: 6, fontWeight: 900, fontSize: 13 }}>
                          {isHost ? 'Host może uruchomić nową grę.' : 'Oczekiwanie na hosta.'}
                        </div>
                      </div>
                    </div>

                    <div style={{ marginTop: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(3,7,18,0.55)', padding: 10 }}>
                      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Gracze</div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {winnerPlayers.map((p) => {
                          const status = getPlayerStatusLabel(p);
                          const dot = COLOR_HEX[p.colorKey || 'blue'] || '#94a3b8';

                          return (
                            <div
                              key={p.id}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '14px 1fr auto',
                                gap: 10,
                                alignItems: 'center',
                                padding: '10px 10px',
                                borderRadius: 10,
                                border: '1px solid rgba(255,255,255,0.10)',
                                background: p.id === winnerId ? 'rgba(34,197,94,0.10)' : 'rgba(2,6,23,0.45)',
                              }}
                            >
                              <div style={{ width: 10, height: 10, borderRadius: 999, background: dot, border: '1px solid rgba(255,255,255,0.55)' }} />

                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 950, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {p.nickname}{p.id === hostId ? ' (Host)' : ''}{p.id === winnerId ? ' (Winner)' : ''}
                                </div>
                                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                                  Status: <span style={{ opacity: 0.95 }}>{status}</span>
                                </div>
                              </div>

                              <div style={{ textAlign: 'right' }}>
                                <div className="muted" style={{ fontSize: 12 }}>Saldo</div>
                                <div style={{ fontWeight: 950, fontSize: 13 }}>{Number(p.balance || 0)}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
                      {isHost ? (
                        <button type="button" onClick={handleRestartGame} style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}>
                          Nowa gra
                        </button>
                      ) : (
                        <div className="muted">Oczekiwanie na hosta: Nowa gra</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="left-stack">
              <div className="panel">
                <div className="panel-title">Gracze</div>
                <div className="players-list">
                  {gameState.players.map((p) => {
                    const isCurrent = gameState.currentPlayerId === p.id;
                    const isMeLocal = socketId === p.id;

                    const cls = [
                      'player-card',
                      `player-owned--${p.colorKey || 'blue'}`,
                      isCurrent ? 'player-card--current' : '',
                      isMeLocal ? 'player-card--me' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');

                    const showTimer = Boolean(isCurrent && !gameOver && currentTurnTimerTextMemo);
                    const timerStyle = {
                      fontSize: 12,
                      fontWeight: 950,
                      padding: '4px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: p.isDisconnected ? 'rgba(239,68,68,0.15)' : 'rgba(167,139,250,0.14)',
                      opacity: 0.95,
                      minWidth: 58,
                      textAlign: 'center',
                    };

                    return (
                      <div key={p.id} className={cls}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <div className="player-card-name">
                            {p.nickname}{p.id === hostId ? ' (Host)' : ''}
                          </div>
                          <div style={timerStyle}>{showTimer ? currentTurnTimerTextMemo : '--:--'}</div>
                        </div>
                        <div className="player-card-meta">Saldo: {p.balance}</div>
                        <div className="player-card-meta">Pole: {animatedPositions[p.id] ?? p.position}</div>
                        {p.isDisconnected ? <div className="player-card-meta">Status: OFFLINE</div> : null}
                        {p.inJail ? <div className="player-card-meta">Status: WIĘZIENIE</div> : null}
                        {p.isBankrupt ? <div className="player-card-meta">Status: BANKRUT</div> : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="panel">
                <div className="panel-title">Sterowanie</div>
                <div className="controls-grid">
                  <div className="small-line"><strong>Tura gracza:</strong> {currentPlayer ? currentPlayer.nickname : '-'}</div>
                  <div className="small-line"><strong>Twoja tura:</strong> {isMyTurn ? 'TAK' : 'NIE'}</div>
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    Ulepszenia: kliknij swoją nieruchomość (pełny set) przed rzutem kośćmi.
                  </div>
                  <div className="controls-row">
                    <button
                      onClick={handleRollDice}
                      disabled={
                        !isMyTurn ||
                        gameOver ||
                        isMeBankrupt ||
                        isMeAnimating ||
                        Boolean(cardModal) ||
                        Boolean(jailModal) ||
                        Boolean(paymentModal) ||
                        Boolean(buyModalOpen) ||
                        Boolean(upgradeModalTileId) ||
                        gameState.phase !== 'awaiting_roll'
                      }
                      type="button"
                    >
                      Rzuć kośćmi
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="board-wrap">
              <div className="board-classic">
                <div className="corner tl">{renderTile(tl, 'top', 'tile-corner')}</div>
                <div className="corner tr">{renderTile(tr, 'top', 'tile-corner')}</div>
                <div className="corner bl">{renderTile(bl, 'bottom', 'tile-corner')}</div>
                <div className="corner br">{renderTile(br, 'bottom', 'tile-corner')}</div>

                <div className="edge top-edge">{topEdgeIds.map((id) => renderTile(getTile(id), 'top', 'tile-vertical'))}</div>
                <div className="edge bottom-edge">{bottomEdgeIds.map((id) => renderTile(getTile(id), 'bottom', 'tile-vertical'))}</div>
                <div className="edge left-edge">{leftEdgeIds.map((id) => renderTile(getTile(id), 'left', 'tile-horizontal'))}</div>
                <div className="edge right-edge">{rightEdgeIds.map((id) => renderTile(getTile(id), 'right', 'tile-horizontal'))}</div>

                <div className="center-area">
                  <div className="center-title">Monopolista</div>
                  <div className="center-sub">Classic board layout</div>
                </div>
              </div>
            </div>

            <div className="activity-panel">
              <div className="activity-tabs">
                <button
                  className={'activity-tab ' + (activeTab === 'chat' ? 'activity-tab--active' : '')}
                  onClick={() => setActiveTab('chat')}
                  type="button"
                >
                  Czat
                </button>
                <button
                  className={'activity-tab ' + (activeTab === 'log' ? 'activity-tab--active' : '')}
                  onClick={() => setActiveTab('log')}
                  type="button"
                >
                  Log gry
                </button>
              </div>

              <div className="activity-scroll" ref={activityScrollRef}>
                {activeTab === 'chat' ? (
                  <>
                    {messages.length === 0 && <div className="muted">Brak wiadomości...</div>}
                    {messages.map((m, i) => (
                      <div key={i}>
                        <strong>{m.nickname}:</strong> {m.message}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    {gameLog.length === 0 && <div className="muted">Brak zdarzeń...</div>}
                    {gameLog.map((e, i) => (
                      <div key={i} className="log-line">
                        <span className="log-time">[{new Date(e.ts).toLocaleTimeString()}]</span> {e.text}
                      </div>
                    ))}
                  </>
                )}
              </div>

              {activeTab === 'chat' && (
                <div className="activity-input">
                  <input
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    placeholder="Wpisz wiadomość..."
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSendMessage();
                    }}
                  />
                  <button onClick={handleSendMessage} type="button">Wyślij</button>
                </div>
              )}
            </div>
          </div>
        )}

        {toast && (
          <div className={'floating-toast ' + (toast.type === 'ok' ? 'floating-toast--ok' : 'floating-toast--err')}>
            {toast.text}
          </div>
        )}
      </div>
    </div>
  );
}
