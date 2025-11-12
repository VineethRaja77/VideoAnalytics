# Hyperspark Video Management System

## Overview

Hyperspark is a professional video management system (VMS) designed for monitoring and managing IP cameras. The application provides live camera streaming, playback capabilities, and camera configuration through a dark-themed, enterprise-grade dashboard interface. Built as a full-stack application with React frontend and Express backend, it targets security monitoring environments with emphasis on usability and professional aesthetics.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Technology Stack**: React with TypeScript, Vite build system, TanStack Query for data fetching

**UI Framework**: Custom design system built on shadcn/ui components with Radix UI primitives and Tailwind CSS for styling

**Design System**:
- Dark mode enterprise aesthetic with navy backgrounds (#0F172A) and elevated surfaces (#1E293B)
- Hyperspark blue (#0B63FF) as primary brand color for actions and active states
- Status-driven color system: green for online, red for offline, amber for warnings
- Inter font family for modern, readable typography
- Responsive grid layouts optimized for camera monitoring dashboards

**Layout Structure**:
- Three-panel layout: fixed left sidebar (240px), top header (64px), main content area
- Left sidebar contains logo and primary navigation (Live, Add Camera, Playback)
- Top header includes search, notifications, and user profile controls
- Main content area uses responsive grid for camera cards

**State Management**: React Query handles server state and caching, with local React state for UI interactions

**Component Architecture**:
- Modular component structure with separation between UI primitives and domain components
- Example components provided for development/testing in `client/src/components/examples/`
- Shared types and schemas via `@shared` alias for type safety between frontend and backend

### Backend Architecture

**Runtime**: Node.js with Express.js framework

**API Design**: RESTful endpoints under `/api` prefix
- Authentication: `/api/auth/login`
- Camera management: CRUD operations at `/api/cameras`
- Recording retrieval: `/api/recordings/:cameraId`

**Data Storage Strategy**: Currently using in-memory storage (MemStorage class) for development
- Designed to be swapped for database implementation via IStorage interface
- Schema defined using Drizzle ORM with PostgreSQL dialect in preparation for database integration
- Three main entities: users, cameras, recordings

**Session Management**: Basic authentication without session persistence (production-ready session management needed)

**Development Server**: Vite middleware integration for HMR during development, static file serving in production

### Data Models

**Users**: Basic authentication with username/password (passwords not hashed in current implementation)

**Cameras**:
- Channel ID, name, stream URL, stream type (RTSP)
- Optional credentials for camera access
- Recording policy (continuous/motion/scheduled)
- Status tracking (online/offline/inactive)
- Location metadata

**Recordings**:
- Linked to specific cameras via foreign key
- Start/end timestamps, file path, duration
- Supports date range queries for playback functionality

### Module Breakdown

**Live View Module**: Grid display of all cameras with status indicators, quick actions (view live, audio toggle, snapshot, fullscreen), and modal player for full-screen viewing

**Add Camera Module**: Form-based camera configuration with connection testing, support for RTSP streams, credential management, and recording policy selection

**Playback Module**: Camera selection, date picker for recording lookup, playback controls (play/pause, speed adjustment, progress tracking), and download capability

## External Dependencies

### UI Component Libraries
- **Radix UI**: Unstyled, accessible component primitives (dialogs, dropdowns, popovers, etc.)
- **shadcn/ui**: Pre-styled component layer built on Radix UI with Tailwind
- **Lucide React**: Icon library for UI elements

### Data Fetching & State
- **TanStack Query (React Query)**: Server state management, caching, background refetching

### Database & ORM
- **Drizzle ORM**: Type-safe SQL query builder and schema management
- **@neondatabase/serverless**: PostgreSQL driver (configured but not actively used with in-memory storage)
- **drizzle-zod**: Zod schema generation from Drizzle schemas for runtime validation

### Form Handling
- **React Hook Form**: Form state management and validation
- **@hookform/resolvers**: Validation resolver integration
- **Zod**: Schema validation library

### Styling & UI Utilities
- **Tailwind CSS**: Utility-first CSS framework
- **class-variance-authority**: Variant-based component styling
- **clsx + tailwind-merge**: Class name composition utilities
- **date-fns**: Date formatting and manipulation

### Development Tools
- **Vite**: Fast build tool and development server
- **TypeScript**: Type safety across the codebase
- **ESBuild**: Production bundling for server code
- **Replit plugins**: Runtime error overlay, cartographer, dev banner for Replit environment

### Other Dependencies
- **cmdk**: Command palette component (imported but usage not evident in provided files)
- **embla-carousel-react**: Carousel/slider functionality
- **vaul**: Drawer component library
- **input-otp**: OTP input components
- **react-day-picker**: Calendar/date picker component
- **recharts**: Charting library (imported but not actively used in provided code)