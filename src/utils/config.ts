// Configuration for API and WebSocket URLs
export const API_BASE_URL = import.meta.env.VITE_API_URL;
export const WS_BASE_URL = API_BASE_URL.replace(/^http/, 'ws') + '/ws';


// Helper functions to build URLs
export const getApiUrl = (path: string) => `${API_BASE_URL}${path}`;
export const getWsUrl = () => WS_BASE_URL;