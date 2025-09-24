import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NavLink } from 'react-router-dom'
import '../../style/GameOption.css'
import { Storage } from '../../utils/storage';
import { checkIfBanned } from '../lobby/ModerationComponents';

function GameOption() {
    const [gameCode, setGameCode] = useState('');
    const [error, setError] = useState('');
    const [isCreatingPlayer, setIsCreatingPlayer] = useState(false);
    const navigate = useNavigate();

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

    const handleJoinGame = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!gameCode.trim()) {
            setError('Please enter a game code');
            return;
        }
        
        // Check if player is banned before trying to join
        const formattedGameCode = gameCode.toUpperCase().trim();
        const banInfo = checkIfBanned(formattedGameCode);
        if (banInfo) {
            setError(`You have been banned from this game. Reason: ${banInfo.reason || 'No reason provided'}`);
            return;
        }

        try {
            // First ensure we have a player
            const playerId = await ensurePlayer();

            const response = await fetch('https://apiwikigame.abdelrahimriche.com/games/join', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameCode: formattedGameCode,
                    playerId
                }),
            });

            if (!response.ok) {
                const data = await response.json();
                if (data.error === 'INVALID_PLAYER') {
                    Storage.clear(); // Clear invalid credentials
                    setError('Failed to create player. Please try again.');
                } else {
                    setError(data.message || 'Failed to join game');
                }
                return;
            }

            Storage.setGameCode(formattedGameCode);
            navigate(`/lobby/${formattedGameCode}`);
        } catch (error) {
            console.error('Error joining game:', error);
            setError('Failed to join game. Please try again.');
        }
    };

    return (
        <>
            <section className="game-options fade-in">
                <div className="option">
                    <h2 className='start'>LAUNCH YOUR GAME</h2>
                    <div className="join-btnDiv">
                        <NavLink to="/choice" className="start-btn">
                            <svg width="15" height="15" viewBox="0 0 35 40" fill="none"
                                xmlns="http://www.w3.org/2000/svg" style={{ marginRight: '10px' }}>
                                <path
                                    d="M33.1562 16.7739L5.65625 0.51605C3.42188 -0.804262 0 0.476988 0 3.74261V36.2504C0 39.1801 3.17969 40.9457 5.65625 39.477L33.1562 23.227C35.6094 21.7817 35.6172 18.2192 33.1562 16.7739Z"
                                    fill="#F1B24A" />
                            </svg>
                            START IT
                        </NavLink>
                        <svg className="topright" width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink">
                            <rect width="100" height="100" fill="url(#pattern0_111_7)" />
                            <defs>
                                <pattern id="pattern0_111_7" patternContentUnits="objectBoundingBox" width="1" height="1">
                                    <use xlinkHref="#image0_111_7" transform="scale(0.01)" />
                                </pattern>
                                <image id="image0_111_7" width="100" height="100" xlinkHref="data:image/png;base64,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" />
                            </defs>
                        </svg>
                    </div>
                </div>
                <div className="option">
                    <h2>JOIN YOUR FRIENDS</h2>
                    <form onSubmit={handleJoinGame} className="join-form">
                        <div className="join-btnDiv">
                            <input
                                type="text"
                                className="join-btn"
                                placeholder="ENTER THE CODE"
                                name="code"
                                value={gameCode}
                                onChange={(e) => setGameCode(e.target.value.toUpperCase())}
                                maxLength={6}
                            />
                            <button type="submit" className="join-submit" disabled={isCreatingPlayer}>
                                {isCreatingPlayer ? 'JOINING...' : 'JOIN'}
                            </button>
                        </div>
                    </form>
                    {error && <p className="error-message">{error}</p>}
                </div>
            </section>
        </>
    )
}

export default GameOption
