// Configuration for API and WebSocket URLs
export const API_BASE_URL = 'https://apiwikigame.abdelrahimriche.com';
export const WS_BASE_URL =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + 'apiwikigame.abdelrahimriche.com/ws';


// Helper functions to build URLs
export const getApiUrl = (path: string) => `${API_BASE_URL}${path}`;
export const getWsUrl = () => WS_BASE_URL;