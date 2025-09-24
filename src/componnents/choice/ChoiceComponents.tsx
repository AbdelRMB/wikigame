import { NavLink, useNavigate } from "react-router-dom";
import { Storage } from "../../utils/storage";
import { useState } from "react";
import { getApiUrl } from '../../utils/config';

const Multi = () => {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [isCreatingPlayer, setIsCreatingPlayer] = useState(false);

  // Create a player if one doesn't exist
  const ensurePlayer = async () => {
    const playerId = Storage.getPlayerId();
    if (playerId) return playerId;

    try {
      setIsCreatingPlayer(true);
      const response = await fetch('https://apiwikigame.abdelrahimriche.com/players/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message);

      Storage.setPlayerId(data.id);
      return data.id;
    } catch (error) {
      console.error('Error creating player:', error);
      throw error;
    } finally {
      setIsCreatingPlayer(false);
    }
  };

  const handleCreateLobby = async () => {
    try {
      // First ensure we have a player

      const playerId = await ensurePlayer();
      
      console.log('Creating game with player ID:', playerId);
      
      const response = await fetch(getApiUrl('/games/create-game'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          id_creator: playerId
        }),
      });

      console.log('Response status:', response.status);
      const data = await response.json();
      console.log('Response data:', data);

      if (!response.ok) {
        if (data.error === 'INVALID_PLAYER') {
          Storage.clear(); // Clear invalid credentials
          setError('Failed to create player. Please try again.');
        } else {
          setError(data.message || 'Failed to create lobby');
        }
        return;
      }

      if (data.game_code) {
        console.log('Game created successfully with code:', data.game_code);
        Storage.setGameCode(data.game_code);
        navigate(`/lobby/${data.game_code}`);
      } else {
        setError('No game code received from server');
      }
    } catch (error) {
      console.error('Error creating lobby:', error);
      setError('Failed to create lobby. Please try again.');
    }
  };

  return (
    <div 
      className={"Multi"} 
      onClick={handleCreateLobby} 
      style={{ cursor: isCreatingPlayer ? 'wait' : 'pointer' }}
    >
      <h1>MULTI</h1>
      {error && <p className="error-message" style={{ color: 'red' }}>{error}</p>}
      {isCreatingPlayer && <p>Creating player...</p>}
    </div>
  );
};

const Solo = () => {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [isCreatingPlayer, setIsCreatingPlayer] = useState(false);

  // Create a player if one doesn't exist
  const ensurePlayer = async () => {
    const playerId = Storage.getPlayerId();
    if (playerId) return playerId;

    try {
      setIsCreatingPlayer(true);
      const response = await fetch('https://apiwikigame.abdelrahimriche.com/players/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message);

      Storage.setPlayerId(data.id);
      return data.id;
    } catch (error) {
      console.error('Error creating player:', error);
      throw error;
    } finally {
      setIsCreatingPlayer(false);
    }
  };

  const handleCreateLobby = async () => {
    try {
      // First ensure we have a player

      const playerId = await ensurePlayer();

      console.log('Creating game with player ID:', playerId);

      const response = await fetch(getApiUrl('/games/create-game'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          id_creator: playerId
        }),
      });

      console.log('Response status:', response.status);
      const data = await response.json();
      console.log('Response data:', data);

      if (!response.ok) {
        if (data.error === 'INVALID_PLAYER') {
          Storage.clear(); // Clear invalid credentials
          setError('Failed to create player. Please try again.');
        } else {
          setError(data.message || 'Failed to create lobby');
        }
        return;
      }

      if (data.game_code) {
        console.log('Game created successfully with code:', data.game_code);
        Storage.setGameCode(data.game_code);
        navigate(`/lobbySolo`);
      } else {
        setError('No game code received from server');
      }
    } catch (error) {
      console.error('Error creating lobby:', error);
      setError('Failed to create lobby. Please try again.');
    }
  };

  return (
      <div
          className={"Solo"}
          onClick={handleCreateLobby}
          style={{ cursor: isCreatingPlayer ? 'wait' : 'pointer' }}
      >
        <h1>SOLO</h1>
        {error && <p className="error-message" style={{ color: 'red' }}>{error}</p>}
        {isCreatingPlayer && <p>Creating player...</p>}
      </div>
  );
};

export const ChoicePanel = () => {
  return (
    <div className={"ChoicePanel"}>
      <Solo />
      <h1>- OR -</h1>
      <Multi />
    </div>
  );
};