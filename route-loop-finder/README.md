# Route Loop Finder

A modern, React-based frontend for the Route Loop Finder application.

## Features
- **Interactive Map**: Drop pins to generate route loops
- **Real-time Updates**: Routes appear instantly via WebSocket
- **Path Filtering**: Filter by distance and drawn selection
- **Minimal Interface**: Clean, map-focused design

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```
   > **Note**: This project is configured for Node.js 18+ comparability.

2. **Start Development Server**
   ```bash
   npm start
   # or
   npm run dev
   ```
   The app will open at http://localhost:5173

3. **Build for Production**
   ```bash
   npm run build
   ```

## Architecture
- **Vite + React**: Fast development and building
- **Leaflet**: Lightweight mapping
- **WebSocket**: Real-time backend communication
- **Vanilla CSS**: Clean, dependency-free styling

## Backend Requirement
Ensure your Python backend is running on `ws://localhost:8765` for route generation to work.
