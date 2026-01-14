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

// Client-side display timers (UI only)
const TURN_TIMEOUT_MS = 60 * 1000;
const DISCONNECT_GRACE_MS = 90 * 1000;

const COLOR_HEX = {
  blue: '#3B82F6',
  yellow: '#FACC15',
  red: '#EF4444',
  green: '#22C55E',
};

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
    const rent = Number(levels[idx] || 0);
    return { mode: 'fixed', text: `Czynsz: ${rent}` };
  }

  if (tile.type === 'station') {
    const stations = countOwnerStations(board, tile.ownerId);
    const base = Number(tile.rent || 25);
    const mult = Math.pow(2, clamp(stations, 1, 4) - 1);
    return { mode: 'fixed', text: `Czynsz: ${base * mult}` };
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
  } catch (e) {
    // ignore
  }
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

export default function App() {
  const [screen, setScreen] = useState('home'); // 'home' | 'lobby' | 'game'
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

  const animatingRef = useRef({}); // { [playerId]: true }
  const timersRef = useRef({}); // { [playerId]: { timer?: any, preTimer?: any } }

  const [toast, setToast] = useState(null); // { type:'ok'|'err', text }

  const [showWinnerModal, setShowWinnerModal] = useState(false);

  const [cardModal, setCardModal] = useState(null); // { deckLabel, text, nickname, colorKey }
  const [jailModal, setJailModal] = useState(null); // { fine:number }

  const [paymentQueue, setPaymentQueue] = useState([]);
  const paymentModal = paymentQueue.length > 0 ? paymentQueue[0] : null;

  // Buy modal
  const [buyModalOpen, setBuyModalOpen] = useState(false);
  const [buyModalTileId, setBuyModalTileId] = useState(null);

  // Turn timer (UI)
  const [turnDeadlineMs, setTurnDeadlineMs] = useState(null);
  const [turnLeftMs, setTurnLeftMs] = useState(0);
  const lastTurnKeyRef = useRef('');

  const activityScrollRef = useRef(null);
  const stickToBottomRef = useRef(true);

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

  // Scroll tracking (chat/log)
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

  // Countdown ticker
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

  // Keep buy modal in sync with server state
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
      setAnimatedPositions({});
      setToast({ type: 'ok', text: 'Nowa gra' });
      setTimeout(() => setToast(null), 1600);

      setBuyModalOpen(false);
      setBuyModalTileId(null);

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

      if (!currentId) {
        setTurnDeadlineMs(null);
        setTurnLeftMs(0);
        lastTurnKeyRef.current = '';
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
      setToast({ type: payload.type === 'ok' ? 'ok' : 'err', text: String(payload.text) });
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
      // IMPORTANT: listen only to camelCase event to avoid duplicates
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

    // Only camelCase events (fixes duplicated modals)
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

  const isInRoom = Boolean(currentRoom);
  const isPlaying = roomStatus === 'playing';
  const isWaiting = roomStatus === 'waiting';

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
    setBuyModalOpen(false);
    setBuyModalTileId(null);

    setTurnDeadlineMs(null);
    setTurnLeftMs(0);
    lastTurnKeyRef.current = '';
  };

  const handleGoToLobby = () => {
    setScreen('lobby');
    setError('');
  };

  const handleBackToHome = () => {
    setScreen('home');
    setShowHowTo(false);
    setError('');
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

  // FIX: emit only camelCase to avoid duplicates
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

  // FIX: emit only camelCase to avoid duplicates
  const handleCardOk = () => {
    if (!currentRoom) return;
    setCardModal(null);
    socket.emit('cardAck', { roomCode: currentRoom });
  };

  const handlePaymentOk = () => {
    setPaymentQueue((prev) => prev.slice(1));
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

  const handleBuyConfirm = () => {
    if (!currentRoom) return;
    socket.emit('buyTile', { roomCode: currentRoom }, (res) => {
      if (!res?.ok) {
        setToast({ type: 'err', text: 'Nie można kupić pola.' });
        setTimeout(() => setToast(null), 2200);
      }
    });
    setBuyModalOpen(false);
  };

  const handleBuySkip = () => {
    if (!currentRoom) return;
    socket.emit('skipBuy', { roomCode: currentRoom });
    setBuyModalOpen(false);
  };

  const isMyTurn = Boolean(gameState?.currentPlayerId && socketId && gameState.currentPlayerId === socketId);
  const currentPlayer = gameState?.players?.find((p) => p.id === gameState?.currentPlayerId) || null;

  const isMeBankrupt = Boolean(me?.isBankrupt);
  const isMeAnimating = Boolean(socketId && animatingRef.current[socketId]);

  const board = Array.isArray(gameState?.board) ? gameState.board : [];
  const getTile = (id) => board[id] || null;

  const buyTile = useMemo(() => {
    if (typeof buyModalTileId !== 'number') return null;
    return getTile(buyModalTileId);
  }, [buyModalTileId, board]);

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

  const canBuyNow = Boolean(
    !gameOver &&
      !isMeBankrupt &&
      !isMeAnimating &&
      !cardModal &&
      !jailModal &&
      !paymentModal &&
      isMyTurn &&
      gameState?.phase === 'awaiting_buy' &&
      gameState?.pending?.playerId === socketId
  );

  const tl = getTile(20);
  const tr = getTile(30);
  const bl = getTile(10);
  const br = getTile(0);

  const topEdgeIds = makeRange(21, 29);
  const bottomEdgeIds = makeRange(1, 9).reverse();
  const leftEdgeIds = makeRange(11, 19).reverse();
  const rightEdgeIds = makeRange(31, 39);

  const renderTile = (tile, side, extraClass = '') => {
    if (!tile) return null;

    const ownerColorKey = tile.ownerId ? ownerColorMap[tile.ownerId] || 'blue' : null;
    const ownedClass = ownerColorKey ? `owned--${ownerColorKey}` : '';
    const typeClass = `board-tile--${tile.type || 'property'}`;

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

    return (
      <div className={tileClass} title={tile.name}>
        {badgeText && <div className="price-badge">{badgeText}</div>}

        <div className="tile-top">
          <div className="tile-name">{tile.name}</div>
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

  const playersSortedForModal = useMemo(() => {
    const list = Array.isArray(gameState?.players) ? [...gameState.players] : [];
    const winnerId = winner?.id || null;

    list.sort((a, b) => {
      const aW = a.id === winnerId ? 1 : 0;
      const bW = b.id === winnerId ? 1 : 0;
      if (aW !== bW) return bW - aW;

      const aB = a.isBankrupt ? 1 : 0;
      const bB = b.isBankrupt ? 1 : 0;
      if (aB !== bB) return aB - bB;

      return (b.balance || 0) - (a.balance || 0);
    });

    return list;
  }, [gameState, winner]);

  const currentTurnTimerText = useMemo(() => {
    if (!isPlaying || gameOver) return '';
    if (!currentPlayer?.id) return '';
    return formatTimeLeft(turnLeftMs);
  }, [isPlaying, gameOver, currentPlayer, turnLeftMs]);

  const showMenu = screen !== 'game';
  return (
    <div className="app">
      <div className="card">
        {showMenu && (
          <div className="menu-shell">
            <div className="menu-card">
              {screen === 'home' && (
                <>
                  <div className="menu-title">Monopolista</div>
                  <div className="menu-sub">Multiplayer • Socket.IO • Monopoly-like</div>

                  <div className="menu-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <button type="button" onClick={handleGoToLobby} style={{ width: '100%' }}>
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
                      onClick={handleBackToHome}
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
                      <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Wpisz nick..." />
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
                          <button onClick={handleCreateRoom} disabled={loadingRoom} type="button" style={{ width: '100%' }}>
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

                        <div className="menu-hint">
                          Host tworzy pokój, kopiuje kod i wysyła znajomemu. Drugi gracz dołącza kodem.
                        </div>
                      </>
                    )}

                    {isInRoom && isWaiting && (
                      <div className="lobby-box" style={{ marginTop: 14 }}>
                        <div className="lobby-title">
                          Pokój: <strong>{currentRoom}</strong>
                        </div>

                        <div className="menu-actions" style={{ marginTop: 10, flexDirection: 'column', alignItems: 'stretch' }}>
                          <button type="button" onClick={handleCopyRoomCode} style={{ width: '100%', marginTop: 0 }}>
                            Kopiuj kod
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowHowTo(true)}
                            style={{ background: '#334155', width: '100%', marginTop: 0 }}
                          >
                            Jak grać
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

                        {!allReady && <div className="lobby-hint">Wymagane: minimum 2 graczy i wszyscy GOTOWI.</div>}
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
                    {/* (rules content stays unchanged) */}
                    <div style={{ marginBottom: 12 }}>
                      <strong>W skrócie</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        Twoim celem jest zostać ostatnim graczem, który nie zbankrutuje. Kupuj nieruchomości, pobieraj czynsz
                        i pilnuj, żeby zawsze mieć zapas gotówki na podatki oraz opłaty.
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <strong>1) Jak zacząć grę (multiplayer)</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        • Host wybiera <strong>Stwórz pokój</strong>, a potem kopiuje kod pokoju i wysyła go znajomym.<br />
                        • Pozostali gracze wpisują kod i klikają <strong>Dołącz do pokoju</strong>.<br />
                        • W lobby każdy ustawia status <strong>GOTOWY</strong> (minimum 2 graczy).<br />
                        • Gdy wszyscy są gotowi, host uruchamia rozgrywkę.
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <strong>2) Tura gracza</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        W swojej turze rzucasz <strong>dwiema kośćmi (2d6)</strong> i przesuwasz pionek o wylosowaną liczbę pól.
                        Po ruchu dzieje się jedna z kilku rzeczy:
                        <div style={{ marginTop: 8 }}>
                          • Jeśli pole jest wolne i możliwe do kupienia — możesz je <strong>kupić</strong> albo <strong>pominąć</strong> zakup.<br />
                          • Jeśli staniesz na cudzym polu — płacisz <strong>czynsz</strong> właścicielowi.<br />
                          • Jeśli trafisz na podatek — płacisz odpowiednią kwotę.<br />
                          • Jeśli wejdziesz na <strong>Szansa</strong> lub <strong>Kasa społeczna</strong> — losujesz kartę.
                        </div>
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <strong>3) Kupowanie i czynsz</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        Nieruchomości, dworce i media można kupować, gdy są wolne. Kupione pole zaczyna dla Ciebie pracować:
                        gdy inny gracz na nie wejdzie, zapłaci <strong>czynsz</strong>.
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <strong>4) START i pola specjalne</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        Gdy przejdziesz przez START, otrzymujesz bonus <strong>+200</strong> (gra nalicza to automatycznie).
                        Uważaj też na pola „Idź do więzienia” oraz podatki — potrafią szybko uszczuplić budżet.
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <strong>5) Karty: Szansa / Kasa społeczna</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        Karta wyświetla się tylko graczowi, który ją wylosował. Po kliknięciu <strong>OK</strong> efekt zostaje zastosowany
                        (np. ruch pionka, nagroda, opłata albo więzienie).
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <strong>6) Więzienie</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        Jeśli trafisz do więzienia, dostajesz wybór:
                        <div style={{ marginTop: 8 }}>
                          • <strong>Zapłać karę</strong> i wychodzisz od razu.<br />
                          • <strong>Pomiń turę</strong> — zostajesz w więzieniu i tracisz tę kolejkę.
                        </div>
                      </div>
                    </div>
                    <div>
                      <strong>7) Bankructwo i zwycięstwo</strong>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                        Jeśli Twoje saldo spadnie poniżej zera — bankrutujesz, a Twoje pola wracają do banku.
                        Wygrywa ostatni gracz, który pozostaje aktywny.
                      </div>
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

            {toast && (
              <div className={'floating-toast ' + (toast.type === 'ok' ? 'floating-toast--ok' : 'floating-toast--err')}>
                {toast.text}
              </div>
            )}
          </div>
        )}

        {screen === 'game' && isPlaying && gameState && (
          <div className="game-shell">
            {/* ✅ Show modals only AFTER animation finishes */}
            {paymentModal && !cardModal && !jailModal && !buyModalOpen && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(620px, 100%)' }}>
                  <div className="modal-title">{formatPaymentTitle(paymentModal)}</div>
                  <div className="modal-body">{formatPaymentBody(paymentModal)}</div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      onClick={handlePaymentOk}
                      style={{ width: 'auto', padding: '10px 18px', marginTop: 0 }}
                    >
                      {formatPaymentButton(paymentModal)}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {buyModalOpen && canBuyNow && buyTile && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(720px, 100%)', textAlign: 'left' }}>
                  {/* (buy modal content unchanged) */}
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
                      <div
                        style={{
                          borderRadius: 12,
                          border: '1px solid rgba(255,255,255,0.10)',
                          background: 'rgba(2,6,23,0.55)',
                          padding: 10,
                        }}
                      >
                        <div className="muted" style={{ fontSize: 12 }}>
                          Cena zakupu
                        </div>
                        <div style={{ marginTop: 4, fontWeight: 950, fontSize: 18 }}>{buyPrice}</div>
                      </div>

                      <div
                        style={{
                          borderRadius: 12,
                          border: '1px solid rgba(255,255,255,0.10)',
                          background: 'rgba(2,6,23,0.55)',
                          padding: 10,
                        }}
                      >
                        <div className="muted" style={{ fontSize: 12 }}>
                          Saldo (teraz → po zakupie)
                        </div>
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

                    {buyTile.type !== 'property' && (
                      <div className="muted" style={{ marginTop: 10, lineHeight: 1.5 }}>
                        To pole przynosi zyski, gdy inni gracze na nie wejdą (czynsz).
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                      Wskazówka: zostaw trochę gotówki na podatki i czynsze.
                    </div>

                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        type="button"
                        onClick={handleBuySkip}
                        style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}
                      >
                        Pomiń zakup
                      </button>

                      <button
                        type="button"
                        onClick={handleBuyConfirm}
                        disabled={!canAfford(meBalance, buyPrice)}
                        style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}
                      >
                        Kup za {buyPrice}
                      </button>
                    </div>
                  </div>

                  {!canAfford(meBalance, buyPrice) && (
                    <div style={{ marginTop: 10, color: '#f87171', fontSize: 13 }}>
                      Nie masz wystarczająco pieniędzy, aby kupić to pole.
                    </div>
                  )}
                </div>
              </div>
            )}

            {cardModal && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9998 }}>
                <div className="modal-card" style={{ width: 'min(620px, 100%)' }}>
                  <div className="modal-title">{cardModal.deckLabel || 'Karta'}</div>
                  <div className="modal-body">{cardModal.text}</div>

                  {cardModal.nickname && (
                    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: 0.9 }}>
                      <div
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          background: COLOR_HEX[cardModal.colorKey || 'blue'] || '#94a3b8',
                          border: '1px solid rgba(255,255,255,0.35)',
                        }}
                      />
                      <div style={{ fontSize: 13 }}>
                        Gracz: <strong>{cardModal.nickname}</strong>
                      </div>
                    </div>
                  )}

                  <div className="modal-actions">
                    <button type="button" onClick={handleCardOk} style={{ width: 'auto', padding: '10px 18px', marginTop: 0 }}>
                      OK
                    </button>
                  </div>
                </div>
              </div>
            )}

            {jailModal && !isMeAnimating && (
              <div className="modal-overlay" style={{ zIndex: 9999 }}>
                <div className="modal-card" style={{ width: 'min(680px, 100%)' }}>
                  <div className="modal-title">Więzienie</div>

                  <div className="modal-body">
                    Wybierz opcję:
                    <div className="muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
                      • Zapłać <strong>{jailModal.fine}</strong> i wyjdź z więzienia
                      <br />
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

            {/* Winner modal can show immediately */}
            {gameOver && showWinnerModal && (
              <div className="modal-overlay" style={{ zIndex: 9997 }}>
                <div className="modal-card" style={{ width: 'min(720px, 100%)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div className="modal-title" style={{ margin: 0 }}>
                      {winner ? `Zwycięzca: ${winner.nickname}` : 'Koniec gry'}
                    </div>
                    <button type="button" onClick={() => setShowWinnerModal(false)} style={{ width: 'auto', padding: '10px 14px', marginTop: 0, background: '#334155' }}>
                      Zamknij
                    </button>
                  </div>

                  <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                    Lista graczy:
                  </div>

                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {playersSortedForModal.map((p) => {
                      const isW = winner && p.id === winner.id;
                      const isB = Boolean(p.isBankrupt);
                      const badge = isW ? 'WINNER' : isB ? 'BANKRUT' : 'AKTYWNY';

                      return (
                        <div
                          key={p.id}
                          style={{
                            borderRadius: 12,
                            border: '1px solid rgba(255,255,255,0.10)',
                            padding: '10px 12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            background: 'rgba(3,7,18,0.55)',
                          }}
                        >
                          <div
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: 999,
                              background: COLOR_HEX[p.colorKey || 'blue'] || '#94a3b8',
                              border: '1px solid rgba(255,255,255,0.35)',
                              flex: '0 0 auto',
                            }}
                          />
                          <div style={{ fontWeight: 900, flex: '1 1 auto' }}>
                            {p.nickname}
                            {p.id === hostId ? ' (Host)' : ''}
                          </div>
                          <div style={{ opacity: 0.9, fontSize: 13 }}>Saldo: {p.balance}</div>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 900,
                              padding: '4px 8px',
                              borderRadius: 999,
                              border: '1px solid rgba(255,255,255,0.12)',
                              background: isW ? 'rgba(34,197,94,0.15)' : isB ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.10)',
                            }}
                          >
                            {badge}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    {isHost ? (
                      <button type="button" onClick={handleRestartGame} style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}>
                        Nowa gra
                      </button>
                    ) : (
                      <div style={{ opacity: 0.8, fontSize: 13, alignSelf: 'center' }}>Oczekiwanie na hosta: Nowa gra</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* LEFT */}
            <div className="left-stack">
              <div className="panel">
                <div className="panel-title">Gracze</div>

                <div className="players-list">
                  {gameState.players.map((p) => {
                    const isCurrent = gameState.currentPlayerId === p.id;
                    const isMe = socketId === p.id;

                    const cls = [
                      'player-card',
                      `player-owned--${p.colorKey || 'blue'}`,
                      isCurrent ? 'player-card--current' : '',
                      isMe ? 'player-card--me' : '',
                    ].filter(Boolean).join(' ');

                    const showTimer = Boolean(isCurrent && !gameOver && currentTurnTimerText);
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

                          <div style={timerStyle}>
                            {showTimer ? currentTurnTimerText : '--:--'}
                          </div>
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
                  <div className="small-line">
                    <strong>Tura gracza:</strong> {currentPlayer ? currentPlayer.nickname : '-'}
                  </div>
                  <div className="small-line">
                    <strong>Twoja tura:</strong> {isMyTurn ? 'TAK' : 'NIE'}
                  </div>

                  {gameOver && winner && <div className="hud-toast hud-toast--ok">Zwycięzca: {winner.nickname}</div>}

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
                        gameState.phase !== 'awaiting_roll'
                      }
                      type="button"
                    >
                      Rzuć kośćmi
                    </button>
                  </div>

                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    Zakup pola odbywa się w osobnym oknie. Ten panel zostanie później użyty do negocjacji (trade).
                  </div>

                  {toast && (
                    <div className={'hud-toast ' + (toast.type === 'ok' ? 'hud-toast--ok' : 'hud-toast--err')}>
                      {toast.text}
                    </div>
                  )}

                  {diceInfo && (
                    <div className="small-line">
                      Ostatni rzut: {diceInfo.nickname} → {diceInfo.dice1}+{diceInfo.dice2}={diceInfo.steps}, pole {diceInfo.newPosition} ({diceInfo.tile.name})
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* CENTER */}
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

            {/* RIGHT */}
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
                  <button onClick={handleSendMessage} type="button">
                    Wyślij
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
