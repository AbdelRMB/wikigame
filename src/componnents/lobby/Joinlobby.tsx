import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import '../../style/Joinlobby.css';
import { Storage } from '../../utils/storage';
import { getApiUrl } from '../../utils/config';
import Navbar from "../Navbar";
import { checkIfBanned } from './ModerationComponents';

function Joinlobby() {
    const { gameCode } = useParams();
    const [error, setError] = useState('');
    const [isCreatingPlayer, setIsCreatingPlayer] = useState(false);
    const navigate = useNavigate();
    
    // Check for bans immediately on component mount
    useEffect(() => {
        if (gameCode) {
            const banInfo = checkIfBanned(gameCode);
            if (banInfo) {
                console.log('Player is banned from this game, redirecting to home:', banInfo);
                // Show error message instead of alert for better UX
                setError(`You have been banned from this game. Reason: ${banInfo.reason || 'No reason provided'}`);
                // Prevent joining by disabling the component
                setIsCreatingPlayer(true);
                // Navigate back after a short delay
                setTimeout(() => {
                    navigate('/');
                }, 3000);
            }
        }
    }, [gameCode, navigate]);

    // Create a player if one doesn't exist
    const ensurePlayer = async () => {
        const playerId = Storage.getPlayerId();
        if (playerId) return playerId;

        try {
            setIsCreatingPlayer(true);
            const response = await fetch(getApiUrl('/players/create'), {
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

        if (!gameCode) {
            setError('Code de partie invalide');
            return;
        }
        
        // Check if player is banned before trying to join
        const banInfo = checkIfBanned(gameCode);
        if (banInfo) {
            setError(`You have been banned from this game. Reason: ${banInfo.reason || 'No reason provided'}`);
            // Navigate back after a short delay
            setTimeout(() => {
                navigate('/');
            }, 3000);
            return;
        }

        try {
            // First ensure we have a player
            const playerId = await ensurePlayer();

            const response = await fetch(getApiUrl('/games/join'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameCode: gameCode.toUpperCase(),
                    playerId
                }),
            });

            if (!response.ok) {
                const data = await response.json();
                if (data.error === 'INVALID_PLAYER') {
                    Storage.clear(); // Clear invalid credentials
                    setError('Erreur lors de la création du joueur. Veuillez réessayer.');
                } else {
                    setError(data.message || 'Impossible de rejoindre la partie');
                }
                return;
            }

            Storage.setGameCode(gameCode.toUpperCase());
            navigate(`/lobby/${gameCode.toUpperCase()}`);
        } catch (error) {
            console.error('Error joining game:', error);
            setError('Impossible de rejoindre la partie. Veuillez réessayer.');
        }
    };

    return (
        <div className="join-container">
            <div className="join-box">
                <h2>REJOINDRE LA PARTIE</h2>
                <p>Voulez-vous rejoindre la partie {gameCode} ?</p>
                <form onSubmit={handleJoinGame} className="join-form">
                    <div className="join-btnDiv2">
                        <button type="submit" className="join-submit2" disabled={isCreatingPlayer}>
                            {isCreatingPlayer ? 'CONNEXION...' : 'REJOINDRE'}
                        </button>
                        <button type="button" className="cancel-button" onClick={() => navigate('/')} disabled={isCreatingPlayer}>
                            ANNULER
                        </button>
                    </div>
                </form>
                {error && <p className="error-message">{error}</p>}
            </div>
        </div>
    );
}

export default Joinlobby;
