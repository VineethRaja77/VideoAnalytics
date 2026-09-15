# `client/` — the React SPA

[← back to the root README](../README.md) · siblings: [server/](../server/README.md) · [shared/](../shared/README.md)

React 18 + TypeScript + Vite, served by the same Express process that serves the
API — one origin, so cookies and media never cross an origin boundary. TanStack
Query owns server state; there is no Redux and no client-side router library
beyond a `View` union in [`App.tsx`](src/App.tsx).

```
client/
  index.html
  public/favicon.png
  src/
    main.tsx            mount
    App.tsx             auth gate + view switch + camera queries
    index.css           Tailwind layers + design tokens
    lib/
      auth.tsx          AuthUser, Role, isSameSession
      queryClient.ts    apiRequest() + the shared QueryFunction
      webrtc.ts         WHEP handshake, one RTCPeerConnection per player
      codecCapability.ts  can this browser decode H.265? (two separate answers)
      utils.ts          cn()
    hooks/
      useWhepPlayer.ts  the live-video hook: path resolution + retry
      use-toast.ts  use-mobile.tsx
    components/
      ui/               ~45 shadcn/ui primitives on Radix — do not hand-edit
      <domain components>
```

---

## Live video is the hard part

Everything else in this app is CRUD. Live video is where the real decisions are.

### The codec decision happens *before* any connection

[`codecCapability.ts`](src/lib/codecCapability.ts) answers two **different**
questions, because the two decode paths genuinely differ:

| Function | Question | Notes |
|---|---|---|
| `browserSupportsH265Webrtc()` | can this browser decode H.265 over **WebRTC**? | Firefox and Edge: never. Chrome: only on Windows with a capable GPU. Safari 18+: yes |
| `browserSupportsH265File()` | can it decode HEVC in an **MP4** `<video>`? | used for recordings playback and export preview |

Both are cached, cost no network, and are checked *before* opening a connection
— never by trial and error, which would show the user a broken player first.

### `useWhepPlayer` — the one place player lifecycle lives

```
camera.status !== "online" ────────────────────▶ do nothing
        │
        ▼
poll for the <video> element to mount   (Radix Dialog portals mount late:
   50ms × 40 attempts = 2s budget)
        │
        ▼
GET /api/webrtc-config/:cameraId ──▶ { whepUrl }
   server picks cam_<id> or cam_<id>_h264 based on the codec support
   this hook reports
        │
        ▼
startWhepPlayback()  → POST our SDP offer, get MediaMTX's SDP answer
        │
        ├── playing
        └── error ──▶ retry at 2s, 4s, 8s, 15s (capped backoff)
```

The retry/reconnect loop is the thing the old per-component `hls.js`
integrations both lacked. Consolidating it into one hook is why
[`CameraCard`](src/components/CameraCard.tsx) and
[`LivePlayerModal`](src/components/LivePlayerModal.tsx) behave identically.

`webrtc.ts` keeps the WHEP client deliberately small: one
`RTCPeerConnection` with `iceServers: []` (media is same-network or reaches the
box directly over `8189/udp`), `recvonly` transceivers for video and audio, and
a single POST of the SDP offer.

---

## Session identity is per browser profile, not per tab

Session cookies are scoped to the **browser profile**. Admin and client portal
sessions are intentionally split into `vms.admin.sid` and `vms.client.sid`,
selected by the `X-VMS-Portal` request header. That lets a Super Admin tab and a
client-admin tab coexist in the same browser. Within one portal, a second login
still rebinds that portal's cookie jar, so stale-tab detection remains needed.

[`auth.tsx`](src/lib/auth.tsx) therefore exposes `isSameSession(a, b)`, and
`AuthUser` carries `sessionStartedAt` (epoch ms of the login backing this
session, changing on every fresh login). Polling `/api/auth/me` and comparing
detects a same-portal rebind and forces the stale tab back to the login screen.
The login response itself returns the full `AuthUser` payload, so a successful
login does not need an extra `/api/auth/me` roundtrip before rendering.

`AuthUser.licensedModules` is `string[]` or `"*"` (super admin). The UI uses it
to hide unlicensed surfaces — but hiding is cosmetic; the authoritative gate is
`entitlements.ts` on the server.

---

## Views

| Component | Purpose |
|---|---|
| [`LoginPage`](src/components/LoginPage.tsx) | credentials → `POST /api/auth/login` |
| [`AppSidebar`](src/components/AppSidebar.tsx) / [`TopHeader`](src/components/TopHeader.tsx) | organization-branded sidebar + header; search, notification bell, profile |
| [`OperationsDashboard`](src/components/OperationsDashboard.tsx) | default client landing page: camera counts, open events, licensed feature count and quick actions |
| [`LiveView`](src/components/LiveView.tsx) + [`CameraCard`](src/components/CameraCard.tsx) | responsive grid of live tiles, each its own WHEP player |
| [`LivePlayerModal`](src/components/LivePlayerModal.tsx) | single-camera expanded view |
| [`cameralist`](src/components/cameralist.tsx) | table view: status, codec, recording state, analytics bindings |
| [`AddCameraForm`](src/components/AddCameraForm.tsx) | RTSP/ONVIF details; `POST /api/cameras/test-connection` probes the stream and reports the detected codec before saving |
| [`PlaybackView`](src/components/PlaybackView.tsx) | recorded segments; requests the `?codec=h264` variant when the browser cannot decode HEVC in a file |
| [`EventsCenter`](src/components/EventsCenter.tsx) | one client-facing analytics event center; module tabs appear only for licensed feature groups |
| [`ModuleEventsView`](src/components/ModuleEventsView.tsx) | generic per-module event table; PPE, person, vehicle and face views specialise it |
| [`OrgUsers`](src/components/OrgUsers.tsx) | client-admin user management within one org |
| [`SuperAdminConsole`](src/components/SuperAdminConsole.tsx) | platform admin: Overview, Organizations, Licensing, Models, System, Audit, Settings |
| [`AuditLogView`](src/components/AuditLogView.tsx) | the append-only trail, filtered |

---

## Data fetching

[`queryClient.ts`](src/lib/queryClient.ts) exports `apiRequest(method, url, data?)`
— always `credentials: "include"`, always throwing on a non-2xx with the body
text as the message, so component `onError` handlers can show something real.
`getQueryFn({ on401 })` chooses between returning `null` (an expected logged-out
read) and throwing.

Cameras are polled at 10s in `App.tsx`; live *video* liveness is the peer
connection's own business, not the query's. Route chunks are loaded on demand:
a previous eager prefetch of every client page after login created a burst of
background downloads and made slower browsers feel stuck. Hashed production
assets are served immutable by `server/serve.ts`.

---

## Styling

Tailwind 3 + shadcn/ui on Radix primitives, configured by
[`components.json`](../components.json) and [`tailwind.config.ts`](../tailwind.config.ts).
Palette and typography rules live in
[design_guidelines.md](../design_guidelines.md). Current product screens use a
light, work-focused shell for both Super Admin and client portals, with
status-driven green/red/amber and Inter.

Files under `src/components/ui/` are generated shadcn primitives. Prefer
composing them; if one must change, change it deliberately and note it, because
a future `shadcn add` will not preserve edits.

---

## Aliases and build

| Alias | Resolves to |
|---|---|
| `@/` | `client/src/` |
| `@shared/` | `shared/` — the same schema and `MODULE_FEATURES` catalogue the server imports |
| `@assets/` | `attached_assets/` |

`npm run build` puts the bundle in `dist/public`, which
[`server/serve.ts`](../server/serve.ts) serves in production. In development
Vite runs as Express middleware, mounted **last** so it never shadows `/api`.
