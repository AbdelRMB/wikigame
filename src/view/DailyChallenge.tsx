import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../componnents/Navbar';
import '../style/DailyChallenge.css';
import {postRequest} from "../backend/services/apiService.js";
import {getApiUrl} from "../utils/config";
import { Storage } from '../utils/storage';

interface Challenge {
    id: string;
    title: string;
    description: string;
    target: string;
    reward: number;
    difficulty: string;
    date?: string;
}

interface Player {
    id: string;
    name: string;
    completionTime: number;
    rank: number;
}

interface PastChallenge extends Challenge {
    date: string;
    completionTime?: number;
    rank?: number;
    players?: Player[];
}

type SortField = 'date' | 'title' | 'time' | 'rank';
type SortDirection = 'asc' | 'desc';

const DailyChallenge: React.FC = () => {
    const [isMobile, setIsMobile] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [dailyChallenge, setDailyChallenge] = useState<Challenge | null>(null);
    const [pastChallenges, setPastChallenges] = useState<PastChallenge[]>([]);
    const [showPastChallenges, setShowPastChallenges] = useState(false);
    const [sortField, setSortField] = useState<SortField>('date');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
    const [selectedChallenge, setSelectedChallenge] = useState<string | null>(null);
    const navigate = useNavigate();

    // Vérifier si l'appareil est un mobile
    useEffect(() => {
        const checkIfMobile = () => {
            const userAgent = navigator.userAgent.toLowerCase();
            const isMobileDevice = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
            setIsMobile(isMobileDevice);
            setIsLoading(false);
        };

        checkIfMobile();
    }, []);

    // Simuler le chargement du daily challenge et des anciens challenges
    useEffect(() => {
        if (isMobile) {
            // Simulation de l'API qui renvoie le daily challenge
            setTimeout(() => {
                const mockChallenge = {
                    id: 'dc-' + new Date().toISOString().split('T')[0],
                    title: 'Challenge du jour',
                    description: 'Trouvez l\'article sur "Intelligence Artificielle" en moins de 3 minutes',
                    target: 'Intelligence_artificielle',
                    reward: 100,
                    difficulty: 'Moyen'
                };
                setDailyChallenge(mockChallenge);
            }, 1500);

            // Simulation de l'API qui renvoie les anciens challenges
            setTimeout(async () => {
                try {
                    const mockPastChallenges = await postRequest(getApiUrl("/challenges/past-challenge"), {});
                    setPastChallenges(mockPastChallenges);
                } catch (error) {
                    console.error("Erreur lors du chargement des sessions de jeu :", error);
                }
            }, 2000);
        }
    }, [isMobile]);

    // Tri des challenges passés
    const sortedPastChallenges = [...pastChallenges].sort((a, b) => {
        let comparison = 0;

        switch (sortField) {
            case 'date':
                // Conversion des dates au format DD/MM/YYYY en objets Date pour comparaison
                const dateA = a.date.split('/').reverse().join('-');
                const dateB = b.date.split('/').reverse().join('-');
                comparison = new Date(dateA).getTime() - new Date(dateB).getTime();
                break;
            case 'title':
                comparison = a.title.localeCompare(b.title);
                break;
            case 'time':
                // Traitement spécial pour les temps de complétion nuls
                if (a.completionTime === 0 && b.completionTime === 0) comparison = 0;
                else if (a.completionTime === 0) comparison = 1;
                else if (b.completionTime === 0) comparison = -1;
                else comparison = (a.completionTime || 0) - (b.completionTime || 0);
                break;
            case 'rank':
                // Traitement spécial pour les rangs nuls
                if (a.rank === null && b.rank === null) comparison = 0;
                else if (a.rank === null) comparison = 1;
                else if (b.rank === null) comparison = -1;
                else comparison = (a.rank || 0) - (b.rank || 0);
                break;
        }

        // Inverser l'ordre si la direction est descendante
        return sortDirection === 'asc' ? comparison : -comparison;
    });

    const ensurePlayer = async () => {
        const playerId = Storage.getPlayerId();
        if (playerId) return playerId;

        try {
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
        }
    };

    const handleStartChallenge = async () => {
        if (!dailyChallenge) return;
        const playerId = await ensurePlayer();

        try {
            // Demande la position à l'utilisateur
            navigator.geolocation.getCurrentPosition(async (position) => {
                const { latitude, longitude } = position.coords;

                // Stocke le challenge localement
                localStorage.setItem('dailyChallenge', JSON.stringify(dailyChallenge));

                // Crée la partie avec le challenge du jour
                const challengeGame = await postRequest(getApiUrl("/games/create-challenge-game"), {
                    id_creator: playerId
                });

                Storage.setGameId(challengeGame.game_id);

                // Distribue l'article en fonction de la position de l'utilisateur
                await postRequest(getApiUrl("/games/distribute-challenge-articles"), {
                    id_game: challengeGame.game_id,
                    latitude,
                    longitude
                });

                // Redirige vers la partie solo
                navigate('/gameSolo', { state: { targetArticle: dailyChallenge.target } });

            }, (error) => {
                console.error("Erreur de géolocalisation :", error);
                alert("Impossible de récupérer votre position. Veuillez autoriser l'accès à la localisation.");
            });
        } catch (err) {
            console.error("Erreur lors du démarrage du challenge :", err);
            alert("Une erreur est survenue lors du démarrage du challenge.");
        }
    };

    const formatTime = (seconds: number): string => {
        if (seconds === 0) return "Non complété";
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs < 10 ? '0' + secs : secs}`;
    };

    const togglePastChallenges = () => {
        setShowPastChallenges(!showPastChallenges);
        // Réinitialiser le challenge sélectionné lorsqu'on ferme la section
        if (showPastChallenges) {
            setSelectedChallenge(null);
        }
    };

    const handleSort = (field: SortField) => {
        // Si on clique sur le même champ, inverse la direction
        if (field === sortField) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            // Sinon, trie par le nouveau champ
            setSortField(field);
            setSortDirection('asc');
        }
    };

    const getSortIcon = (field: SortField) => {
        if (field !== sortField) return null;
        return sortDirection === 'asc' ? '↑' : '↓';
    };

    const handleChallengeSelect = (challengeId: string) => {
        if (selectedChallenge === challengeId) {
            // Si on clique sur le même challenge, on le désélectionne
            setSelectedChallenge(null);
        } else {
            // Sinon on sélectionne le challenge cliqué
            setSelectedChallenge(challengeId);
        }
    };

    if (isLoading) {
        return (
            <div className="daily-container">
                <Navbar />
                <div className="daily-loading">
                    <div className="loading-spinner"></div>
                    <p>Chargement...</p>
                </div>
            </div>
        );
    }

    if (!isMobile) {
        return (
            <div className="daily-container desktop-message">
                <Navbar />
                <div className="apercuAndMessage">
                    <img className="apercuMobile" src="public/assets/apercuMobile.png" alt="apercuMobile" style={{
                        height: '60vh',
                        borderRadius: '20px',
                        border: 'solid 5px black',
                        marginTop: '20px'
                    }}/>
                    <div className="not-mobile-message">
                        <h2>Daily Challenge uniquement sur mobile</h2>
                        <p>Les daily challenges sont disponibles uniquement sur les appareils mobiles.</p>
                        <p>Veuillez vous connecter depuis votre smartphone ou tablette pour y accéder.</p>
                        <div className="phone-icon">
                            <i className="fas fa-mobile-alt"></i>
                        </div>
                        <button onClick={() => navigate('/')} className="back-button">
                            Retour à l'accueil
                        </button>

                        <div className="download-buttons">
                            <img src="public/assets/appStoreButton.png" alt="AppStoreButton"/>
                            <img src="public/assets/playStoreButton.png" alt="playStoreButton"/>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="daily-container">
            <Navbar/>
            <div className="daily-content">
                <h1>DAILY CHALLENGE</h1>

                {dailyChallenge ? (
                    <div className="challenge-card">
                        <div className="challenge-header">
                            <h2>{dailyChallenge.title}</h2>
                            <span className="difficulty">{dailyChallenge.difficulty}</span>
                        </div>
                        <p className="challenge-description">{dailyChallenge.description}</p>
                        <button onClick={handleStartChallenge} className="start-challenge-btn">
                            RELEVER LE DÉFI
                        </button>
                    </div>
                ) : (
                    <div className="daily-loading">
                        <div className="loading-spinner"></div>
                        <p>Chargement du défi du jour...</p>
                    </div>
                )}

                <div className="daily-info">
                    <h3>Comment ça fonctionne</h3>
                    <p>Un nouveau défi tous les jours. Relevez-le pour gagner des points et débloquer des récompenses exclusives!</p>
                </div>

                <div className="past-challenges-section">
                    <div className="past-challenges-header" onClick={togglePastChallenges}>
                        <h3>Les anciens challenges</h3>
                        <span className={`toggle-icon ${showPastChallenges ? 'open' : ''}`}>
                            <i className={`fas fa-chevron-${showPastChallenges ? 'up' : 'down'}`}></i>
                        </span>
                    </div>

                    {showPastChallenges && (
                        <div className="past-challenges-list">
                            {sortedPastChallenges.length > 0 ? (
                                <div>
                                    <div className="past-challenge-header-row">
                                        <span
                                            className="header-date sortable"
                                            onClick={() => handleSort('date')}
                                        >
                                            Date {getSortIcon('date')}
                                        </span>
                                        <span
                                            className="header-title sortable"
                                            onClick={() => handleSort('title')}
                                        >
                                            Challenge {getSortIcon('title')}
                                        </span>
                                    </div>
                                    {sortedPastChallenges.map((challenge) => (
                                        <React.Fragment key={challenge.id}>
                                            <div
                                                className={`past-challenge-item ${selectedChallenge === challenge.id ? 'selected' : ''}`}
                                                onClick={() => handleChallengeSelect(challenge.id)}
                                            >
                                                <span className="challenge-date">{challenge.date}</span>
                                                <span className="challenge-title">{challenge.title}</span>
                                            </div>

                                            {selectedChallenge === challenge.id && challenge.players && (
                                                <div className="challenge-leaderboard">
                                                    <div className="leaderboard-header">
                                                        <span className="leaderboard-rank">Rang</span>
                                                        <span className="leaderboard-player">Joueur</span>
                                                        <span className="leaderboard-time">Temps</span>
                                                    </div>
                                                    {challenge.players.map((player) => (
                                                        <div key={player.id} className="leaderboard-item">
                                                            <span className="leaderboard-rank">{player.rank}</span>
                                                            <span className="leaderboard-player">{player.name}</span>
                                                            <span className="leaderboard-time">{formatTime(player.completionTime)}</span>
                                                        </div>
                                                    ))}
                                                    <div className="leaderboard-close" onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelectedChallenge(null);
                                                    }}>
                                                        Fermer
                                                    </div>
                                                </div>
                                            )}
                                        </React.Fragment>
                                    ))}
                                </div>
                            ) : (
                                <p className="no-past-challenges">Aucun ancien challenge trouvé.</p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default DailyChallenge;