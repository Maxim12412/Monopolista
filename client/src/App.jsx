import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000');

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

export default function App() {
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

  const [toast, setToast] = useState(null); // { type:'ok'|'err', text }

  // Winner modal
  const [showWinnerModal, setShowWinnerModal] = useState(false);

  // Scroll handling (auto-scroll only if user is at bottom)
  const activityScrollRef = useRef(null);
  const stickToBottomRef = useRef(true);

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
    const updateSocketId = () => setSocketId(socket.id || null);
    updateSocketId();

    socket.on('connect', updateSocketId);
    socket.on('reconnect', updateSocketId);
    socket.on('disconnect', () => setSocketId(null));

    socket.on('roomUpdate', (payload) => {
      setRoomStatus(payload.status || 'waiting');
      setHostId(payload.hostId || null);
      setReadyById(payload.readyById || {});
      setPlayers(payload.players || []);
    });

    socket.on('newMessage', (msg) => setMessages((prev) => [...prev, msg]));
    socket.on('gameLogEvent', (entry) => setGameLog((prev) => [...prev, entry]));

    socket.on('gameReset', () => {
      setGameLog([]);
      setDiceInfo(null);
      setShowWinnerModal(false);
      setToast({ type: 'ok', text: 'Nowa gra' });
      setTimeout(() => setToast(null), 1600);
    });

    socket.on('gameState', (state) => {
      setGameState(state);
      setAnimatedPositions((prev) => {
        const next = { ...prev };
        (state.players || []).forEach((pl) => {
          if (next[pl.id] === undefined || next[pl.id] === null) next[pl.id] = pl.position;
        });
        return next;
      });
    });

    socket.on('diceRolled', (info) => {
      setDiceInfo(info);
      setAnimatedPositions((prev) => ({ ...prev, [info.playerId]: info.newPosition }));
    });

    socket.on('toast', (payload) => {
      if (!payload || !payload.text) return;
      setToast({ type: payload.type === 'ok' ? 'ok' : 'err', text: String(payload.text) });
      setTimeout(() => setToast(null), 2200);
    });

    return () => {
      socket.off('connect', updateSocketId);
      socket.off('reconnect', updateSocketId);
      socket.off('disconnect');
      socket.off('roomUpdate');
      socket.off('newMessage');
      socket.off('gameLogEvent');
      socket.off('gameReset');
      socket.off('gameState');
      socket.off('diceRolled');
      socket.off('toast');
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
    (list || []).forEach((p) => { map[p.id] = p.colorKey || 'blue'; });
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

      setMessages([]);
      setGameLog([]);
      setActiveTab('chat');
      setGameState(null);
      setDiceInfo(null);
      setAnimatedPositions({});
      setToast(null);
      setShowWinnerModal(false);
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

      setMessages([]);
      setGameLog([]);
      setActiveTab('chat');
      setGameState(null);
      setDiceInfo(null);
      setAnimatedPositions({});
      setToast(null);
      setShowWinnerModal(false);
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

  const handleBuyTile = () => {
    if (!currentRoom) return;
    socket.emit('buyTile', { roomCode: currentRoom }, (res) => {
      if (res?.ok) {
        setToast({ type: 'ok', text: 'Zakup udany.' });
        setTimeout(() => setToast(null), 1800);
        return;
      }
      setToast({ type: 'err', text: 'Nie można kupić pola.' });
      setTimeout(() => setToast(null), 2200);
    });
  };

  const handleSkipBuy = () => {
    if (!currentRoom) return;
    socket.emit('skipBuy', { roomCode: currentRoom });
  };

  const handleSendMessage = () => {
    if (!messageText.trim() || !currentRoom) return;
    socket.emit('sendMessage', { roomCode: currentRoom, nickname, message: messageText.trim() });
    setMessageText('');
  };

  const isMyTurn = Boolean(gameState?.currentPlayerId && socketId && gameState.currentPlayerId === socketId);
  const currentPlayer = gameState?.players?.find((p) => p.id === gameState?.currentPlayerId) || null;

  const isMeBankrupt = Boolean(me?.isBankrupt);

  const canBuyNow = Boolean(
    !gameOver &&
    !isMeBankrupt &&
    gameState?.phase === 'awaiting_buy' &&
    gameState?.pending?.playerId === socketId &&
    isMyTurn
  );

  const board = Array.isArray(gameState?.board) ? gameState.board : [];
  const getTile = (id) => board[id] || null;

  // Corners (based on current indices)
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

    const ownerColorKey = tile.ownerId ? (ownerColorMap[tile.ownerId] || 'blue') : null;
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
    ].filter(Boolean).join(' ');

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

  return (
    <div className="app">
      <div className="card">
        {!isPlaying && (
          <>
            {!isInRoom && (
              <>
                <label>Nick:
                  <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Wpisz nick..." />
                </label>

                <label>Kod pokoju:
                  <input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="Wpisz kod" />
                </label>

                {error && <div style={{ color: '#f97373', marginTop: 8, fontSize: 13 }}>{error}</div>}

                <button onClick={handleCreateRoom} disabled={loadingRoom} type="button">
                  {loadingRoom ? 'Tworzenie...' : 'Stwórz pokój'}
                </button>

                <button onClick={handleJoinRoom} disabled={loadingRoom} style={{ marginTop: 8 }} type="button">
                  {loadingRoom ? 'Dołączanie...' : 'Dołącz do pokoju'}
                </button>
              </>
            )}

            {isInRoom && isWaiting && (
              <div className="lobby-box">
                <div className="lobby-title">Pokój: <strong>{currentRoom}</strong></div>
                <div className="lobby-sub">Host może rozpocząć grę, gdy wszyscy są gotowi.</div>

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
          </>
        )}

        {isPlaying && gameState && (
          <div className="game-shell">
            {/* Winner modal */}
            {gameOver && showWinnerModal && (
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(2,6,23,0.72)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 9999,
                  padding: 16,
                }}
              >
                <div
                  style={{
                    width: 'min(720px, 100%)',
                    borderRadius: 16,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(2,6,23,0.92)',
                    boxShadow: '0 30px 80px rgba(0,0,0,0.65)',
                    padding: 16,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ fontWeight: 950, fontSize: 18 }}>
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

                  <div style={{ marginTop: 10, opacity: 0.85, fontSize: 13 }}>
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
                          <div style={{ opacity: 0.9, fontSize: 13 }}>
                            Saldo: {p.balance}
                          </div>
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
                      <button
                        type="button"
                        onClick={handleRestartGame}
                        style={{ width: 'auto', padding: '10px 14px', marginTop: 0 }}
                      >
                        Nowa gra
                      </button>
                    ) : (
                      <div style={{ opacity: 0.8, fontSize: 13, alignSelf: 'center' }}>
                        Oczekiwanie na hosta: Nowa gra
                      </div>
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

                    return (
                      <div key={p.id} className={cls}>
                        <div className="player-card-name">
                          {p.nickname}{p.id === hostId ? ' (Host)' : ''}
                        </div>
                        <div className="player-card-meta">Saldo: {p.balance}</div>
                        <div className="player-card-meta">Pole: {animatedPositions[p.id] ?? p.position}</div>
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

                  {gameOver && winner && (
                    <div className="hud-toast hud-toast--ok">
                      Zwycięzca: {winner.nickname}
                    </div>
                  )}

                  <div className="controls-row">
                    <button
                      onClick={handleRollDice}
                      disabled={!isMyTurn || gameOver || isMeBankrupt || gameState.phase === 'awaiting_buy'}
                      type="button"
                    >
                      Rzuć kośćmi
                    </button>

                    {canBuyNow && (
                      <>
                        <button onClick={handleBuyTile} type="button">Kup pole</button>
                        <button onClick={handleSkipBuy} type="button">Pomiń zakup</button>
                      </>
                    )}
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

                <div className="edge top-edge">
                  {topEdgeIds.map((id) => renderTile(getTile(id), 'top', 'tile-vertical'))}
                </div>

                <div className="edge bottom-edge">
                  {bottomEdgeIds.map((id) => renderTile(getTile(id), 'bottom', 'tile-vertical'))}
                </div>

                <div className="edge left-edge">
                  {leftEdgeIds.map((id) => renderTile(getTile(id), 'left', 'tile-horizontal'))}
                </div>

                <div className="edge right-edge">
                  {rightEdgeIds.map((id) => renderTile(getTile(id), 'right', 'tile-horizontal'))}
                </div>

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
                      <div key={i}><strong>{m.nickname}:</strong> {m.message}</div>
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
      </div>
    </div>
  );
}
