# Hyperspark Video Management System - Design Guidelines

## Design Approach
**System-Based Approach**: Enterprise security dashboard aesthetic combined with modern SaaS usability. Reference the CP PLUS login page visual style for consistency while maintaining Hyperspark brand identity.

## Color System
- **Primary**: Hyperspark Blue `#0B63FF` - All primary actions, links, active states
- **Success**: Green `#34D399` - Online cameras, successful connections, confirmations
- **Error**: Red `#F87171` - Offline cameras, failed connections, validation errors
- **Warning**: Amber `#FBBF24` - Inactive cameras, warnings
- **Background**: Dark Navy `#0F172A` - Main background (professional monitoring environment)
- **Surface**: `#1E293B` - Cards, panels, elevated surfaces
- **Border**: `#334155` - Subtle dividers and boundaries
- **Text Primary**: `#F1F5F9` - Headings, important text
- **Text Secondary**: `#94A3B8` - Labels, metadata, timestamps

## Typography
- **Font Family**: Inter or similar modern sans-serif
- **Headings**: Medium weight (500-600), clear hierarchy
- **Body**: Regular weight (400), optimized for readability in dark mode
- **Sizes**: H1: 24px, H2: 20px, H3: 16px, Body: 14px, Small: 12px

## Layout Structure

### Three-Part System
**Left Sidebar Navigation** (240px fixed width):
- Hyperspark logo at top (height: 64px)
- Vertical menu items: Live, Add Camera, Playback
- Active state: Blue highlight with subtle background fill
- Icons preceding each menu label

**Top Header Bar** (height: 64px):
- Search input (left-aligned, width: 320px)
- Notification bell icon (badge for unread count)
- User profile avatar with dropdown (right-aligned)

**Main Content Area**:
- Full remaining viewport space
- Padding: 24px on all sides
- Responsive grid layouts for camera cards

## Core Components

### Camera Card (Live Module)
- Card size: 280px × 240px minimum
- Thumbnail/preview area: 280px × 160px
- Camera name (bold, 16px)
- Channel ID badge (small, grey background)
- Connection status indicator: 8px circle (green/red/grey) with label
- Quick action icons row: View Live, Audio Toggle, Snapshot, Fullscreen
- Hover state: Subtle border glow in blue

### Form Inputs (Add Camera Module)
- Input height: 44px
- Label above input (12px, grey)
- Dark background with light border
- Focus state: Blue border, subtle glow
- Inline validation with icons and error text below
- Test Connection button: Secondary style with loading spinner state

### Video Player Interface
- 16:9 aspect ratio player area
- Control bar overlay (bottom): Play/Pause, Timeline scrubber, Speed selector, Frame controls, Fullscreen
- Side panel: Camera details, PTZ controls (directional pad), Stream quality dropdown
- Timeline markers: Motion events as vertical indicators on scrubber

### Status Indicators
- Online: Green circle + "Online" text
- Offline: Red circle + "Offline" text  
- Inactive: Grey circle + "Inactive" text
- Loading: Animated blue spinner

## Spacing System
Use Tailwind units: **2, 4, 6, 8, 12, 16, 24** for consistent rhythm
- Card padding: 16px
- Section spacing: 24px
- Grid gaps: 16px
- Input vertical spacing: 12px

## Navigation & Transitions
- Module switching: Smooth fade transition (200ms)
- Modal overlays: Fade in with slight scale (150ms)
- Loading states: Skeleton placeholders before content loads
- Camera card to live view: Expand animation with blur background

## Empty States
- **Live Module**: Camera icon + "No cameras added yet" + "Add Camera" CTA button
- **Playback Module**: Clock icon + "Select a camera and date to view footage"
- Use centered layout with icon (48px), heading, description, and action button

## Interactive States
- **Buttons**: Primary (blue), Secondary (grey), Danger (red) - All with hover darken and active press states
- **Cards**: Hover elevation with subtle shadow
- **Inputs**: Focus blue border glow
- **Success feedback**: Green checkmark with "Success" toast notification
- **Error feedback**: Red X with error message toast

## Images
No hero images required. This is a functional dashboard application focused on video streams and camera thumbnails. All visuals are data-driven (camera feeds, status indicators, icons).

## Key Design Principles
1. **High Contrast**: Optimized for 24/7 monitoring environments
2. **Status Clarity**: Instant visual feedback on camera and system states
3. **Minimal Distractions**: Clean interface prioritizing operational efficiency
4. **Consistent Feedback**: Every action receives immediate visual confirmation
5. **Professional Polish**: Enterprise-grade appearance matching security industry standards