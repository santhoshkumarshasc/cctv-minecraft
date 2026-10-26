import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import {
  Activity, ArrowDownRight, ArrowUpRight, Camera, ChevronRight,
  Clock3, Expand, Eye, EyeOff, Hexagon, LockKeyhole, LogOut, MessageSquare,
  Monitor, Plus, Radio, RefreshCw, Server, ShieldCheck, Signal, Square,
  Wifi, X,
} from 'lucide-react';
import {
  getGetAdminConfigQueryKey, getGetAdminSessionQueryKey, getGetCameraSummaryQueryKey,
  getListAdminBotsQueryKey, getListCamerasQueryKey, useCreateAdminSession, useCreateBot,
  useDeleteAdminSession, useGetAdminConfig, useGetAdminSession, useGetCameraSummary,
  useListAdminBots, useListCameras, useReconnectBot, useRemoveBot, useSendBotChat,
  useStartBot, useStopBot,
} from '@workspace/api-client-react';
import type { CameraBot, CameraBotInput, CameraSummary } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import islandArt from './assets/floating-world.png';
import './index.css';
import './app.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } });

type MicrosoftDeviceCode = {
  botId: string;
  botName: string;
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  message: string;
};

function HexMark({ size = 28 }: { size?: number }) {
  return <span className="hex-mark" style={{ width: size, height: size }}><Hexagon size={size - 8} strokeWidth={2.2} /><span>+</span></span>;
}

function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  return <span className={`status-pill status-${normalized}`}><i />{normalized === 'online' ? 'LIVE' : normalized}</span>;
}

function Header({ active = 'wall' }: { active?: 'wall' | 'admin' }) {
  return <header className="topbar">
    <Link href="/" className="brand" data-testid="link-home"><HexMark size={36} /><span>block<span className="brand-dot">/</span>watch</span></Link>
    <nav className="nav-pills" aria-label="Main navigation">
      <Link href="/" className={active === 'wall' ? 'nav-link selected' : 'nav-link'} data-testid="link-camera-wall"><Camera size={15} /> Camera wall</Link>
      <Link href="/admin" className={active === 'admin' ? 'nav-link selected' : 'nav-link'} data-testid="link-admin"><LockKeyhole size={14} /> Owner portal</Link>
    </nav>
    <div className="header-note"><span className="tiny-live" /> YOUR WORLDS, IN VIEW</div>
  </header>;
}

function LoadingCard() {
  return <div className="camera-skeleton"><div className="skeleton-screen" /><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
}

function CameraTile({ camera, onOpen }: { camera: CameraBot; onOpen: (camera: CameraBot) => void }) {
  const online = camera.status === 'online';
  return <article className="camera-card" data-testid={`card-camera-${camera.id}`}>
    <button className={`camera-view scanlines ${online ? '' : 'not-live'}`} type="button" onClick={() => onOpen(camera)} aria-label={`Open ${camera.name} camera`} data-testid={`button-open-camera-${camera.id}`}>
      {online && camera.viewerUrl ? <iframe title={`${camera.name} live view`} src={camera.viewerUrl} loading="lazy" allow="autoplay; fullscreen" /> : <div className="camera-placeholder">
        <div className="viewport-cross"><span /><span /></div>
        <div className="placeholder-mark"><HexMark size={42} /></div>
        <strong>{camera.status === 'connecting' || camera.status === 'reconnecting' ? 'Establishing view' : camera.status === 'error' ? 'Signal unavailable' : 'Camera offline'}</strong>
        <small>{camera.status === 'offline' ? 'The owner’s camera is not connected' : camera.status === 'error' ? camera.lastError || 'Check the owner portal for details' : 'Waiting for the world to respond'}</small>
      </div>}
      <div className="camera-overlay-top"><StatusPill status={camera.status} /><span className="rec-mark"><i /> REC</span></div>
      <div className="camera-overlay-bottom"><span>CAM {String(camera.cameraNumber).padStart(2, '0')}</span><span className="mono">LIVE VIEW <Expand size={13} /></span></div>
    </button>
    <div className="camera-meta">
      <div className="camera-title"><div><h3>{camera.name}</h3><p><Server size={13} /> {camera.server}</p></div><button className="icon-button expand-button" onClick={() => onOpen(camera)} aria-label={`Expand ${camera.name}`} data-testid={`button-expand-camera-${camera.id}`}><Expand size={16} /></button></div>
      <div className="camera-stats">
        <span><Signal size={14} /> {online && camera.pingMs != null ? `${camera.pingMs} ms` : camera.version}</span>
        {online && camera.health != null ? <span><Activity size={14} /> {camera.health} health</span> : <span><Clock3 size={14} /> {camera.status}</span>}
        {online && camera.food != null && <span><Activity size={14} /> {camera.food} food</span>}
        <span><Clock3 size={14} /> {formatUptime(camera.uptimeSeconds)}</span>
        {online && camera.x != null && camera.y != null && camera.z != null && <span className="coords mono">{camera.x}, {camera.y}, {camera.z}</span>}
      </div>
    </div>
  </article>;
}

function FullscreenCamera({ camera, close }: { camera: CameraBot; close: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  return <div className="fullscreen-backdrop" role="dialog" aria-modal="true" aria-label={`${camera.name} camera view`} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="fullscreen-panel camera-modal">
      <header><div><StatusPill status={camera.status} /><strong>{camera.name}</strong><span>{camera.server}</span></div><button className="dark-icon-button" onClick={close} aria-label="Close camera view" data-testid="button-close-camera"><X /></button></header>
      <div className="fullscreen-feed scanlines">
        {camera.status === 'online' && camera.viewerUrl ? <iframe title={`${camera.name} fullscreen live view`} src={camera.viewerUrl} allow="autoplay; fullscreen" /> : <div className="fullscreen-empty"><HexMark size={58} /><strong>{camera.status === 'connecting' || camera.status === 'reconnecting' ? 'Connecting to camera' : 'No live signal'}</strong><span>Live footage will appear when this owner-operated camera is online.</span></div>}
        <div className="rec-mark full-rec"><i /> REC</div>
        <div className="timestamp mono">{new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })}</div>
      </div>
    </section>
  </div>;
}

function SummaryNumber({ label, value, color }: { label: string; value: number | undefined; color: string }) {
  return <div className="summary-number"><span className={`summary-dot ${color}`} /><strong>{value ?? '—'}</strong><small>{label}</small></div>;
}

function WallPage() {
  const camerasQuery = useListCameras({ query: { queryKey: getListCamerasQueryKey(), refetchInterval: 30_000 } });
  const summaryQuery = useGetCameraSummary({ query: { queryKey: getGetCameraSummaryQueryKey(), refetchInterval: 30_000 } });
  const [selected, setSelected] = useState<CameraBot | null>(null);
  const cameras = camerasQuery.data ?? [];
  const summary = summaryQuery.data;
  useEffect(() => {
    const socket = io({ path: '/api/socket.io', transports: ['websocket', 'polling'] });
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: getListCamerasQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCameraSummaryQueryKey() });
    };
    ['camera:update', 'camera:status', 'bot:update', 'summary:update', 'camera_update', 'bot_status'].forEach((event) => socket.on(event, refresh));
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, []);
  useEffect(() => {
    if (selected) {
      const updated = cameras.find((camera) => camera.id === selected.id);
      if (updated) setSelected(updated);
    }
  }, [cameras, selected?.id]);
  const latest = summary?.latestUpdate ? new Date(summary.latestUpdate).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Awaiting first update';

  return <main>
    <Header />
    <section className="hero">
      <div className="hero-copy fade-up">
        <div className="eyebrow"><span className="eyebrow-line" /> PRIVATE WORLDS. OPEN WINDOWS.</div>
        <h1>Your world,<br /><em>from the inside.</em></h1>
        <p className="hero-intro">A familiar first-person view into the Minecraft worlds you trust. Check in on your own cameras, wherever the day takes you.</p>
        <div className="hero-actions"><a className="button-primary" href="#camera-wall">Explore camera wall <ArrowDownRight size={16} /></a><Link className="button-quiet" href="/admin">For world owners <ChevronRight size={16} /></Link></div>
        <div className="trust-line"><ShieldCheck size={16} /> Only cameras connected by their owners or authorized operators.</div>
      </div>
      <div className="hero-art-wrap fade-up" style={{ animationDelay: '.12s' }}>
        <div className="hero-art"><img src={islandArt} alt="A small floating block-world island in a soft green sky" /><div className="art-coordinate mono">WORLD / 01 <span>VIEWPORT ACTIVE</span></div>
          <div className="art-window"><div className="window-top"><span>CAMERA STATUS</span><span className="window-indicator" /></div><strong>Private worlds,<br />peace of mind.</strong><div className="window-foot"><HexMark size={23} /><span>BLOCKWATCH<br /><small>OWNER CONTROLLED</small></span></div></div>
          <span className="art-stamp">A VIEW<br />YOU TRUST</span>
        </div>
        <div className="art-caption"><span>01 / A WORLD AT A GLANCE</span><span>BUILT FOR THE PEOPLE WHO BUILT IT</span></div>
      </div>
    </section>
    <section className="wall-section" id="camera-wall">
      <div className="wall-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> THE CAMERA WALL</div><h2>Check in, <em>not out.</em></h2><p>Trusted first-person windows into connected worlds.</p></div>
        <div className="wall-tools"><div className="connection-chip"><span className="tiny-live" /> {summaryQuery.isLoading ? 'Checking connection' : 'Live status'} <span className="chip-divider" /> <span className="mono">{summary?.online ?? '—'} online</span></div><button className="refresh-button" aria-label="Refresh camera wall" onClick={() => { camerasQuery.refetch(); summaryQuery.refetch(); }} data-testid="button-refresh-cameras"><RefreshCw size={15} /></button></div>
      </div>
      <div className="wall-summary">
        <SummaryNumber label="CAMERAS" value={summary?.total} color="forest" />
        <SummaryNumber label="ONLINE" value={summary?.online} color="lime" />
        <SummaryNumber label="OFFLINE" value={summary?.offline} color="stone" />
        <SummaryNumber label="RECONNECTING" value={summary?.reconnecting} color="amber" />
        <div className="last-update"><Clock3 size={14} /><span>LAST CHECK<br /><strong>{latest}</strong></span></div>
      </div>
      {camerasQuery.isLoading ? <div className="camera-grid" aria-label="Loading cameras"><LoadingCard /><LoadingCard /><LoadingCard /></div> :
        camerasQuery.isError ? <div className="state-panel error-state"><div className="state-icon"><Wifi /></div><h3>Camera wall couldn’t load</h3><p>We couldn’t reach the live camera list. Your worlds haven’t been changed.</p><button className="button-primary" onClick={() => { camerasQuery.refetch(); summaryQuery.refetch(); }} data-testid="button-retry-camera-load"><RefreshCw size={15} /> Try again</button></div> :
          cameras.length === 0 ? <div className="state-panel"><div className="empty-orbit"><HexMark size={52} /></div><h3>No cameras connected yet</h3><p>When an owner connects a camera bot, its real status will appear here. No sample feeds are shown.</p><Link href="/admin" className="button-primary">Owner setup <ArrowUpRight size={15} /></Link></div> :
            <div className="camera-grid">{cameras.map((camera) => <CameraTile key={camera.id} camera={camera} onOpen={setSelected} />)}</div>}
    </section>
    <footer className="site-footer"><div className="footer-brand"><HexMark size={26} /> block/watch</div><p>Camera access belongs to the world owner. Every feed reflects an actual connected bot.</p><Link href="/admin">Owner portal <ArrowUpRight size={14} /></Link></footer>
    {selected && <FullscreenCamera camera={selected} close={() => setSelected(null)} />}
  </main>;
}

function LoginPage({ onLogin, pending, error }: { onLogin: (password: string) => void; pending: boolean; error: string }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  return <div className="login-layout">
    <div className="login-story"><div className="eyebrow"><span className="eyebrow-line" /> PRIVATE OPERATOR ACCESS</div><h1>Your worlds<br />stay <em>yours.</em></h1><p>One quiet place to check camera health, manage trusted bots, and keep the view exactly where it belongs.</p><div className="login-note"><ShieldCheck size={19} /><span><strong>Owner-controlled by design</strong><small>Secrets stay on the server. Your browser never stores a Microsoft token.</small></span></div><div className="story-coordinate mono">BLOCKWATCH / OPERATOR DESK <span>ACCESS CONTROLLED</span></div></div>
    <div className="login-card"><div className="login-emblem"><HexMark size={40} /></div><div className="eyebrow">WELCOME BACK</div><h2>Owner sign in</h2><p>Enter your admin password to manage connected cameras.</p>
      <form onSubmit={(event) => { event.preventDefault(); onLogin(password); }}><label htmlFor="admin-password">ADMIN PASSWORD</label><div className="password-wrap"><input id="admin-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder="Enter password" data-testid="input-admin-password" /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} data-testid="button-toggle-password">{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button-primary login-submit" type="submit" disabled={pending || !password} data-testid="button-admin-login">{pending ? 'Checking access…' : 'Continue to portal'} <ArrowUpRight size={16} /></button>
      </form>
      <div className="login-privacy"><LockKeyhole size={14} /> Password is sent securely to the owner API. No secrets are displayed.</div>
    </div>
  </div>;
}

function parsePatrolPath(value: string) {
  return value.split(/[\n;]/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const coordinates = line.split(/[,\s]+/).map(Number);
    if (coordinates.length !== 3 || coordinates.some((coordinate) => !Number.isInteger(coordinate))) return null;
    return { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
  });
}

function BotForm({ versions, defaultVersion, onCancel, onCreate, pending, maxBots, count }: { versions: string[]; defaultVersion: string; onCancel: () => void; onCreate: (input: CameraBotInput) => void; pending: boolean; maxBots: number; count: number }) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('25565');
  const suggestedVersion = versions.includes(defaultVersion) ? defaultVersion : versions.at(-1) ?? '';
  const [version, setVersion] = useState(suggestedVersion);
  const [authMode, setAuthMode] = useState<'offline' | 'microsoft'>('offline');
  const [microsoftEmail, setMicrosoftEmail] = useState('');
  const [antiAfk, setAntiAfk] = useState(true);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [patrolEnabled, setPatrolEnabled] = useState(false);
  const [patrolPath, setPatrolPath] = useState('');
  const [chatEnabled, setChatEnabled] = useState(false);
  const [formError, setFormError] = useState('');
  const unsupportedDefault = !versions.includes(defaultVersion);
  const [permission, setPermission] = useState(false);
  return <div className="fullscreen-backdrop" role="dialog" aria-modal="true" aria-label="Add camera bot">
    <form className="bot-form camera-modal" onSubmit={(event) => {
      event.preventDefault();
      setFormError('');
      const points = parsePatrolPath(patrolPath);
      if (points.some((point) => point === null)) {
        setFormError('Enter each patrol point as three whole numbers: x, y, z.');
        return;
      }
      if (patrolEnabled && points.length < 2) {
        setFormError('A patrol needs at least two waypoints.');
        return;
      }
      if (authMode === 'microsoft' && !microsoftEmail.trim()) {
        setFormError('Enter the Microsoft account email used for server access.');
        return;
      }
      onCreate({
        name: name.trim(), host: host.trim(), port: Number(port), version, authMode,
        microsoftEmail: authMode === 'microsoft' ? microsoftEmail.trim() : undefined,
        serverPermissionConfirmed: permission, antiAfk, autoReconnect, patrolEnabled,
        patrolPath: points.filter((point): point is NonNullable<typeof point> => point !== null),
        chatEnabled,
      });
    }}>
      <div className="form-head"><div><div className="eyebrow"><span className="eyebrow-line" /> OWNER SETUP</div><h2>Add a camera</h2><p>Connect a bot only to a server you own or are authorized to operate.</p></div><button type="button" className="icon-button" aria-label="Close form" onClick={onCancel} data-testid="button-close-add-bot"><X /></button></div>
      <div className="form-grid"><label>CAMERA NAME<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={32} placeholder="e.g. Harbor lookout" data-testid="input-camera-name" /></label><label>SERVER ADDRESS<input value={host} onChange={(event) => setHost(event.target.value)} required maxLength={253} placeholder="play.yourserver.net" data-testid="input-server-host" /></label><label>PORT<input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} required data-testid="input-server-port" /></label><label>MINECRAFT VERSION<select value={version} onChange={(event) => setVersion(event.target.value)} required data-testid="select-server-version">{versions.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label className="wide-field">AUTHENTICATION<select value={authMode} onChange={(event) => setAuthMode(event.target.value as 'offline' | 'microsoft')} data-testid="select-auth-mode"><option value="offline">Offline mode</option><option value="microsoft">Microsoft account (managed server-side)</option></select><small>No Microsoft password or token is entered or stored in this browser.</small></label>
        {authMode === 'microsoft' && <label className="wide-field">MICROSOFT ACCOUNT EMAIL<input type="email" value={microsoftEmail} onChange={(event) => setMicrosoftEmail(event.target.value)} required autoComplete="email" placeholder="account@example.com" data-testid="input-microsoft-email" /><small>When the bot starts, approve the one-time sign-in code in this owner portal.</small></label>}
        {unsupportedDefault && <p className="version-note wide-field">The configured default {defaultVersion} is not in the installed data set yet. {suggestedVersion ? `The latest supported version here is ${suggestedVersion}.` : 'No supported versions were reported.'}</p>}
        <div className="bot-options wide-field">
          <label><input type="checkbox" checked={antiAfk} onChange={(event) => setAntiAfk(event.target.checked)} /> Anti-AFK look and jump</label>
          <label><input type="checkbox" checked={autoReconnect} onChange={(event) => setAutoReconnect(event.target.checked)} /> Reconnect automatically</label>
          <label><input type="checkbox" checked={patrolEnabled} onChange={(event) => setPatrolEnabled(event.target.checked)} /> Enable patrol route</label>
          <label><input type="checkbox" checked={chatEnabled} onChange={(event) => setChatEnabled(event.target.checked)} /> Enable safe chat commands and owner messages</label>
        </div>
        {patrolEnabled && <label className="wide-field patrol-field">PATROL WAYPOINTS <textarea value={patrolPath} onChange={(event) => setPatrolPath(event.target.value)} rows={3} placeholder={'100, 64, 200\n110, 64, 210'} data-testid="input-patrol-path" /><small>Enter one block coordinate per line (x, y, z); at least two are required.</small></label>}
      </div>
      <label className="permission-check"><input type="checkbox" checked={permission} onChange={(event) => setPermission(event.target.checked)} required data-testid="checkbox-server-permission" /><span>I own this Minecraft server or have explicit permission to connect a camera bot to it.</span></label>
      {count >= maxBots && <p className="limit-note">Camera capacity reached ({count} of {maxBots}). Remove a camera before adding another.</p>}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="form-actions"><button type="button" className="button-quiet" onClick={onCancel}>Cancel</button><button className="button-primary" disabled={pending || !permission || count >= maxBots || !versions.length} data-testid="button-create-camera">{pending ? 'Adding…' : 'Add camera'} <Plus size={16} /></button></div>
    </form>
  </div>;
}

function BotRow({ bot, onStart, onStop, onReconnect, onRemove, onChat, busy }: { bot: CameraBot; onStart: () => void; onStop: () => void; onReconnect: () => void; onRemove: () => void; onChat: (message: string) => void; busy: boolean }) {
  const [chat, setChat] = useState('');
  return <article className="bot-row" data-testid={`row-admin-bot-${bot.id}`}>
    <div className="bot-main"><div className="bot-camera-icon"><Camera size={18} /></div><div><h3>{bot.name}</h3><p><Server size={13} /> {bot.server} <span className="bullet">/</span> {bot.version}</p></div><StatusPill status={bot.status} /></div>
    <div className="bot-health">{bot.status === 'online' ? <><span><Signal size={14} /> {bot.pingMs ?? '—'} ms</span><span><Activity size={14} /> {bot.health ?? '—'} hp</span><span className="mono">UP {formatUptime(bot.uptimeSeconds)}</span></> : <span>{bot.lastError || 'No active connection'}</span>}</div>
    <div className="bot-actions">
      {bot.status === 'online' ? <button className="small-action danger-action" onClick={onStop} disabled={busy} data-testid={`button-stop-bot-${bot.id}`}><Square size={14} /> Stop</button> : <button className="small-action" onClick={onStart} disabled={busy} data-testid={`button-start-bot-${bot.id}`}><Radio size={14} /> Start</button>}
      <button className="small-action" onClick={onReconnect} disabled={busy} data-testid={`button-reconnect-bot-${bot.id}`}><RefreshCw size={14} /> Reconnect</button>
      {bot.chatEnabled && <form className="chat-inline" onSubmit={(event) => { event.preventDefault(); if (chat.trim()) { onChat(chat.trim()); setChat(''); } }}><input value={chat} onChange={(event) => setChat(event.target.value)} maxLength={200} placeholder="Send in-game message" aria-label={`Chat message for ${bot.name}`} data-testid={`input-chat-${bot.id}`} /><button className="small-action" disabled={!chat.trim() || busy} aria-label="Send chat message" data-testid={`button-send-chat-${bot.id}`}><MessageSquare size={14} /></button></form>}
      <button className="small-action remove-action" onClick={onRemove} disabled={busy} data-testid={`button-remove-bot-${bot.id}`}>Remove</button>
    </div>
  </article>;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function AdminPage() {
  const client = useQueryClient();
  const session = useGetAdminSession({ query: { queryKey: getGetAdminSessionQueryKey(), retry: false } });
  const login = useCreateAdminSession();
  const logout = useDeleteAdminSession();
  const config = useGetAdminConfig({ query: { queryKey: getGetAdminConfigQueryKey(), enabled: !!session.data?.authenticated, retry: false } });
  const botsQuery = useListAdminBots({ query: { queryKey: getListAdminBotsQueryKey(), enabled: !!session.data?.authenticated, retry: false } });
  const create = useCreateBot();
  const start = useStartBot();
  const stop = useStopBot();
  const reconnect = useReconnectBot();
  const remove = useRemoveBot();
  const chat = useSendBotChat();
  const [loginError, setLoginError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [deviceCodes, setDeviceCodes] = useState<MicrosoftDeviceCode[]>([]);
  const deviceTimers = useRef(new Map<string, number>());
  const authenticated = session.data?.authenticated === true;
  const isBusy = create.isPending || start.isPending || stop.isPending || reconnect.isPending || remove.isPending || chat.isPending;
  const invalidateBots = () => { client.invalidateQueries({ queryKey: getListAdminBotsQueryKey() }); client.invalidateQueries({ queryKey: getListCamerasQueryKey() }); client.invalidateQueries({ queryKey: getGetCameraSummaryQueryKey() }); };
  const failed = (error: unknown) => { const message = error instanceof Error ? error.message : 'The request could not be completed.'; setActionError(message); };
  const runAction = (fn: () => void) => { setActionError(''); setActionNotice(''); fn(); };
  useEffect(() => {
    if (!authenticated) return;
    const socket = io({ path: '/api/socket.io', transports: ['websocket', 'polling'] });
    const updateCamera = (camera: CameraBot) => {
      const update = (current?: CameraBot[]) => {
        const cameras = current ?? [];
        return cameras.some((item) => item.id === camera.id)
          ? cameras.map((item) => item.id === camera.id ? camera : item)
          : [...cameras, camera].sort((left, right) => left.cameraNumber - right.cameraNumber);
      };
      client.setQueryData<CameraBot[]>(getListAdminBotsQueryKey(), update);
      client.setQueryData<CameraBot[]>(getListCamerasQueryKey(), update);
    };
    socket.on('camera:update', updateCamera);
    socket.on('camera:summary', (summary: CameraSummary) => {
      client.setQueryData<CameraSummary>(getGetCameraSummaryQueryKey(), summary);
    });
    socket.on('auth:device-code', (code: MicrosoftDeviceCode) => {
      setDeviceCodes((current) => [...current.filter((item) => item.botId !== code.botId), code]);
      const existingTimer = deviceTimers.current.get(code.botId);
      if (existingTimer) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        setDeviceCodes((current) => current.filter((item) => item.botId !== code.botId));
        deviceTimers.current.delete(code.botId);
      }, Math.max(1, code.expiresIn) * 1000);
      deviceTimers.current.set(code.botId, timer);
    });
    return () => {
      socket.disconnect();
      deviceTimers.current.forEach((timer) => window.clearTimeout(timer));
      deviceTimers.current.clear();
    };
  }, [authenticated, client]);
  const doLogin = (password: string) => { setLoginError(''); login.mutate({ data: { password } }, { onSuccess: () => { client.setQueryData(getGetAdminSessionQueryKey(), { authenticated: true }); client.invalidateQueries({ queryKey: getGetAdminConfigQueryKey() }); client.invalidateQueries({ queryKey: getListAdminBotsQueryKey() }); }, onError: () => setLoginError('That password was not accepted. Check it and try again.') }); };
  const doLogout = () => logout.mutate(undefined, { onSuccess: () => { client.setQueryData(getGetAdminSessionQueryKey(), { authenticated: false }); client.removeQueries({ queryKey: getGetAdminConfigQueryKey() }); client.removeQueries({ queryKey: getListAdminBotsQueryKey() }); }, onError: failed });

  if (session.isLoading) return <><Header active="admin" /><div className="admin-loading"><div className="skeleton-line" /><div className="skeleton-line short" /><div className="camera-skeleton" /></div></>;
  if (!authenticated) return <><Header active="admin" /><LoginPage onLogin={doLogin} pending={login.isPending} error={loginError || (session.isError ? 'No active owner session. Sign in to continue.' : '')} /></>;

  const bots = botsQuery.data ?? [];
  return <main className="admin-page"><Header active="admin" />
    <section className="admin-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> OWNER PORTAL <span className="secure-label"><LockKeyhole size={12} /> SESSION SECURE</span></div><h1>Your camera<br /><em>operations.</em></h1><p>Useful signals, calm controls. Your server credentials never appear in this interface.</p></div>
      <div className="admin-heading-actions"><button className="button-quiet logout-button" onClick={doLogout} disabled={logout.isPending} data-testid="button-admin-logout"><LogOut size={15} /> {logout.isPending ? 'Signing out…' : 'Sign out'}</button><button className="button-primary" onClick={() => setShowAdd(true)} disabled={!config.data || bots.length >= (config.data?.maxBots ?? 0)} data-testid="button-open-add-camera"><Plus size={16} /> Add camera</button></div>
    </section>
    {deviceCodes.map((code) => <div className="device-code-card" role="status" key={code.botId}>
      <div><strong>Sign in to Microsoft for {code.botName}</strong><p>{code.message}</p><a href={code.verificationUri} target="_blank" rel="noreferrer">Open Microsoft sign-in <ArrowUpRight size={13} /></a></div>
      <code>{code.userCode}</code>
      <button className="icon-button" onClick={() => setDeviceCodes((current) => current.filter((item) => item.botId !== code.botId))} aria-label={`Dismiss sign-in code for ${code.botName}`}><X size={15} /></button>
    </div>)}
    <section className="operations-grid">
      <div className="ops-stat"><div className="ops-icon"><Camera size={18} /></div><div><small>CONNECTED CAMERAS</small><strong>{bots.length}<span> / {config.data?.maxBots ?? '—'}</span></strong></div></div>
      <div className="ops-stat"><div className="ops-icon"><Wifi size={18} /></div><div><small>ONLINE NOW</small><strong>{bots.filter((bot) => bot.status === 'online').length}<span> cameras</span></strong></div></div>
      <div className="ops-stat version-stat"><div className="ops-icon"><Monitor size={18} /></div><div><small>DEFAULT VERSION</small><strong>{config.data?.defaultVersion ?? '—'}</strong></div></div>
    </section>
    <section className="manage-section"><div className="manage-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> ACTIVE CONFIGURATION</div><h2>Camera bots <span>{bots.length}</span></h2></div><button className="refresh-button" aria-label="Refresh bot list" onClick={() => { botsQuery.refetch(); config.refetch(); }} data-testid="button-refresh-bots"><RefreshCw size={15} /></button></div>
      {actionError && <div className="admin-alert" role="alert"><span>{actionError}</span><button onClick={() => setActionError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
      {actionNotice && <div className="admin-alert success-alert" role="status"><span>{actionNotice}</span><button onClick={() => setActionNotice('')} aria-label="Dismiss notice"><X size={15} /></button></div>}
      {config.isError && <div className="admin-alert" role="alert">Owner configuration could not load. <button onClick={() => config.refetch()} data-testid="button-retry-config">Retry</button></div>}
      {botsQuery.isLoading ? <div className="bot-list">{[1, 2].map((item) => <LoadingCard key={item} />)}</div> : botsQuery.isError ? <div className="state-panel compact-state"><h3>Bot list unavailable</h3><p>We couldn’t retrieve your configured cameras.</p><button className="button-primary" onClick={() => botsQuery.refetch()} data-testid="button-retry-bots">Retry</button></div> : bots.length ? <div className="bot-list">{bots.map((bot) => <BotRow key={bot.id} bot={bot} busy={isBusy} onStart={() => runAction(() => start.mutate({ botId: bot.id }, { onSuccess: invalidateBots, onError: failed }))} onStop={() => runAction(() => stop.mutate({ botId: bot.id }, { onSuccess: invalidateBots, onError: failed }))} onReconnect={() => runAction(() => reconnect.mutate({ botId: bot.id }, { onSuccess: invalidateBots, onError: failed }))} onRemove={() => { if (window.confirm(`Remove camera “${bot.name}” from this portal?`)) runAction(() => remove.mutate({ botId: bot.id }, { onSuccess: invalidateBots, onError: failed })); }} onChat={(message) => runAction(() => chat.mutate({ botId: bot.id, data: { message } }, { onSuccess: () => setActionNotice('Message sent to the connected bot.'), onError: failed }))} />)}</div> :
        <div className="state-panel compact-state"><div className="empty-orbit"><HexMark size={44} /></div><h3>Your camera wall starts here</h3><p>Add a bot to a server you own or have permission to use. Only its actual status will be shown.</p><button className="button-primary" onClick={() => setShowAdd(true)} disabled={!config.data || bots.length >= (config.data?.maxBots ?? 0)} data-testid="button-add-first-camera"><Plus size={16} /> Add first camera</button></div>}
    </section>
    <section className="security-note"><ShieldCheck size={18} /><div><strong>Owner-first controls</strong><span>Connecting cameras requires explicit server permission. Authentication tokens and passwords are never displayed or stored in frontend state beyond sign-in.</span></div><span className="mono">PORTAL / SECURE</span></section>
     {showAdd && config.data && <BotForm versions={config.data.supportedVersions} defaultVersion={config.data.defaultVersion} maxBots={config.data.maxBots} count={bots.length} pending={create.isPending} onCancel={() => setShowAdd(false)} onCreate={(input) => create.mutate({ data: input }, { onSuccess: () => { setShowAdd(false); invalidateBots(); }, onError: failed })} />}
  </main>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={WallPage} /><Route path="/admin" component={AdminPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
