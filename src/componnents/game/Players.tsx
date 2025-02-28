import React, { useEffect, useState } from "react";
import '../../style/game/Players.css';
import { postRequest } from "../../backend/services/apiService.js";
import { getApiUrl } from "../../utils/config";

// Définir un type pour les joueurs
interface Player {
    id: number;
    pp: string;
    pseudo: string;
    score: number;
}

const Players: React.FC = () => {
    const [players, setPlayers] = useState<Player[]>([]);
    const [articlesToFind, setArticlesToFind] = useState<string[]>([]);

    const fetchPlayers = async () => {
        const data = await postRequest(getApiUrl('/games/players'), {
            id_game: "67b1f4c36fe85f560dd86791"
        });
        setPlayers(data);
    };

    const fetchTargetArticles = async () => {
        const data = await postRequest(getApiUrl('/games/target-articles'), {
            id_game: "67b1f4c36fe85f560dd86791"
        });
        setArticlesToFind(data);
    };

    useEffect(() => {
        fetchPlayers();
        fetchTargetArticles();
    }, []);

    return (
        <div className="players-container fade-in">
            <h2 className="players-title">Joueurs</h2>
            <ul className="players-list">
                {players.map((player, index) => (
                    <div key={index}>
                        <li className="player-item">
                            <img src={player.pp} alt="" className="ppGame"/> - {player.pseudo} - {player.score}/{articlesToFind.length}
                        </li>
                        <hr />
                    </div>
                ))}
            </ul>
        </div>
    );
};

export default Players;