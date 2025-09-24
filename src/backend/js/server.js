//====================================================================================================

// Server API

//====================================================================================================

import express from "express";
import mongoose from "mongoose";
import playerRoutes from "../routes/playerRoutes.js";
import gameRoutes from "../routes/gameRoutes.js";
import articleRoutes from "../routes/articleRoutes.js";
import artifactRoutes from "../routes/artifactRoutes.js";
import challengeRoutes from "../routes/challengeRoutes.js";
import dotenv from "dotenv";
import cors from 'cors';
import Game from "../models/Game.js";
import Player from "../models/Player.js";
import { WebSocket, WebSocketServer } from "ws";
import bodyParser from 'body-parser';
import cron from 'node-cron';
import { postRequest } from "../services/apiService.js";
import Challenge from "../models/Challenge.js";

const PORT = process.env.PORT || 5000;

dotenv.config();

const app = express();
const allowedOrigins = [
    "https://wikigame.abdelrahimriche.com",
    "https://apiwikigame.abdelrahimriche.com",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:4173"
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // Check if the origin is in the allowed list
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        // Allow localhost origins for development (any port)
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            return callback(null, true);
        }
        
        // For production, be strict
        callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true
}));
app.options("*", cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wikigame';

if (!MONGODB_URI) {
    console.error("MONGODB_URI is not defined in environment variables");
    process.exit(1);
}

// Global variables for WebSocket server
let wss;
// Track lobbies and their connected clients
const lobbies = new Map();
// Track player sockets
const playerSockets = new Map();
// Track join/leave attempts to prevent duplicates
const joinAttempts = new Map();
// Track which players have already had leave events processed
const processedLeaveEvents = new Set();
// Track active connections and their last activity time
const clientActivity = new Map();

// Handle game state changes
async function handleGameStateChange(gameCode, event) {
    try {
        console.log(`Handling game state change for ${gameCode}:`, event);
        const game = await Game.findOne({ game_code: gameCode });
        if (!game) {
            console.error(`Game not found: ${gameCode}`);
            return;
        }

        switch (event.type) {
            case 'player_join':
                // When a player joins, broadcast their complete information including skin color
                const joiningPlayer = await Player.findById(event.data.playerId);
                if (joiningPlayer) {
                    broadcastToLobby(gameCode, {
                        type: 'player_join',
                        data: {
                            player: {
                                id: joiningPlayer._id.toString(),
                                pseudo: joiningPlayer.pseudo,
                                pp: joiningPlayer.pp,
                                pp_color: joiningPlayer.pp_color || '#FFAD80',
                                is_host: event.data.isHost
                            }
                        }
                    });
                }
                break;

            case 'player_leave':
                const playerId = event.data.playerId;

                // Only remove player if game is not in progress
                if (game.status !== 'in_progress') {
                    // Find the player in the game
                    const playerIndex = game.players.findIndex(p =>
                        p.player_id && p.player_id.toString() === playerId
                    );

                    if (playerIndex === -1) {
                        console.log(`Player ${playerId} not found in game ${gameCode}, nothing to remove`);
                        return;
                    }

                    // Check if player was host
                    const wasHost = game.players[playerIndex].is_host;

                    // Remove the player
                    game.players.splice(playerIndex, 1);

                    // Only delete the game if it's in the lobby state and has no players
                    // Don't delete games that are in progress or completed
                    if (game.players.length === 0 && game.status === 'lobby') {
                        console.log(`Deleting empty lobby game: ${game._id}`);
                        await Game.deleteOne({ _id: game._id });
                        return;
                    } else if (game.players.length === 0) {
                        console.log(`Game ${game._id} has no players but status is ${game.status}, not deleting`);
                    }

                    // If host leaves, assign new host
                    if (wasHost && game.players.length > 0) {
                        game.players[0].is_host = true;
                        // Broadcast host change event
                        broadcastToLobby(gameCode, {
                            type: 'host_change',
                            data: {
                                newHostId: game.players[0].player_id.toString()
                            }
                        });
                    }

                    // Save the updated game
                    try {
                        await game.save();
                        console.log(`Game state updated for ${gameCode}`);
                    } catch (saveError) {
                        console.error(`Error saving game state for ${gameCode}:`, saveError);
                        // Try to reload and update the game if there was a version error
                        if (saveError.name === 'VersionError') {
                            console.log(`Attempting to reload and update game ${gameCode} due to version error`);
                            const refreshedGame = await Game.findOne({ game_code: gameCode });
                            if (refreshedGame) {
                                // Re-apply the player removal
                                const refreshedPlayerIndex = refreshedGame.players.findIndex(p =>
                                    p.player_id && p.player_id.toString() === playerId
                                );

                                if (refreshedPlayerIndex !== -1) {
                                    refreshedGame.players.splice(refreshedPlayerIndex, 1);
                                    await refreshedGame.save();
                                    console.log(`Successfully updated game ${gameCode} after reload`);
                                }
                            }
                        }
                    }
                } else {
                    console.log(`Game ${gameCode} is in progress, not removing player ${playerId}`);
                }
                break;

            case 'settings_update':
                console.log('Updating game settings:', event.data.settings);
                // Initialize settings if they don't exist
                if (!game.settings) {
                    game.settings = {};
                }
                // Update each setting individually
                const newSettings = event.data.settings;
                game.settings.max_players = newSettings.max_players;
                game.settings.time_limit = newSettings.time_limit;
                game.settings.articles_number = newSettings.articles_number;
                game.settings.visibility = newSettings.visibility;
                game.settings.allow_join = newSettings.allow_join;

                // Update enabled_artifacts if provided
                if (newSettings.enabled_artifacts) {
                    // Convert the enabled_artifacts object to an array of enabled artifact names
                    // Only include artifacts that are explicitly set to true
                    const enabledArtifactsArray = Object.entries(newSettings.enabled_artifacts)
                        .filter(([_, enabled]) => enabled === true)
                        .map(([artifact]) => artifact);

                    // If no artifacts are enabled, use all artifacts
                    if (enabledArtifactsArray.length === 0) {
                        game.settings.enabled_artifacts = [
                            "GPS", "Backtrack", "Teleporter", "Mine", "Snail",
                            "Eraser", "Disorienter", "Dictator"
                        ];
                        console.log('No artifacts enabled, using all artifacts');
                    } else {
                        game.settings.enabled_artifacts = enabledArtifactsArray;
                    }

                    console.log('Updated enabled_artifacts:', game.settings.enabled_artifacts);
                } else {
                    // If no enabled_artifacts provided, use all artifacts
                    game.settings.enabled_artifacts = [
                        "GPS", "Backtrack", "Teleporter", "Mine", "Snail",
                        "Eraser", "Disorienter", "Dictator"
                    ];
                    console.log('No enabled_artifacts provided, using all artifacts');
                }

                // Save the game with updated settings
                await game.save();

                // Verify the save
                const verifyGame = await Game.findOne({ game_code: gameCode });
                if (verifyGame && verifyGame.settings) {
                    console.log('Verified game settings after update:', verifyGame.settings);
                }

                console.log('New game settings:', game.settings);
                break;

            case 'game_start':
                if (gameCode) {
                    try {
                        // First handle the game state change
                        const game = await Game.findOne({ game_code: gameCode });
                        if (!game) {
                            console.error(`Game not found: ${gameCode}`);
                            return;
                        }

                        game.status = 'in_progress';
                        game.start_time = new Date();

                        // Save enabled artifacts if provided
                        if (event.data.enabledArtifacts && Array.isArray(event.data.enabledArtifacts)) {
                            console.log('Received enabledArtifacts:', event.data.enabledArtifacts);

                            // Ensure settings object exists
                            if (!game.settings) {
                                game.settings = {};
                            }

                            // If no artifacts are provided or the array is empty, use all artifacts
                            if (event.data.enabledArtifacts.length === 0) {
                                // Default list of all artifacts
                                game.settings.enabled_artifacts = [
                                    "GPS", "Backtrack", "Teleporter", "Mine", "Snail",
                                    "Eraser", "Disorienter", "Dictator"
                                ];
                                console.log('No artifacts provided, using all artifacts');
                            } else {
                                // Save enabled artifacts in settings and ensure it's an array
                                game.settings.enabled_artifacts = [...event.data.enabledArtifacts];
                            }

                            console.log(`Saving ${game.settings.enabled_artifacts.length} enabled artifacts in settings for game ${gameCode}`);
                            console.log('Game settings before save:', JSON.stringify(game.settings, null, 2));

                            // Save the game with the updated settings
                            await game.save();

                            // Verify the save worked by reloading the game
                            const verifyGame = await Game.findOne({ game_code: gameCode });
                            if (verifyGame && verifyGame.settings) {
                                console.log('Verified saved enabled_artifacts:', verifyGame.settings.enabled_artifacts);
                                if (!verifyGame.settings.enabled_artifacts || verifyGame.settings.enabled_artifacts.length === 0) {
                                    console.error('Failed to save enabled artifacts!');
                                }
                            }
                        } else {
                            // If no enabledArtifacts provided, use all artifacts
                            if (!game.settings) {
                                game.settings = {};
                            }

                            // Default list of all artifacts
                            game.settings.enabled_artifacts = [
                                "GPS", "Backtrack", "Teleporter", "Mine", "Snail",
                                "Eraser", "Disorienter", "Dictator"
                            ];

                            console.log('No enabledArtifacts provided, using all artifacts');
                            await game.save();
                        }

                        // Ensure all players in the lobby are in the game's players array
                        const lobbyClients = lobbies.get(gameCode) || new Set();
                        console.log(`Found ${lobbyClients.size} clients in lobby ${gameCode}`);

                        // Important: Do NOT remove the lobby when the game starts
                        // The lobby is still needed for chat and other communications

                        // Get all player IDs from the lobby
                        const lobbyPlayerIds = new Set();
                        for (const client of lobbyClients) {
                            if (client.currentPlayerId) {
                                lobbyPlayerIds.add(client.currentPlayerId);
                                console.log(`Found player ${client.currentPlayerId} in lobby ${gameCode}`);
                            }
                        }

                        // Also check the playerSockets map
                        for (const [playerId, ws] of playerSockets.entries()) {
                            if (ws.currentLobby === gameCode) {
                                lobbyPlayerIds.add(playerId);
                                console.log(`Found player ${playerId} in playerSockets map for lobby ${gameCode}`);
                            }
                        }

                        // Check if any players need to be added to the game
                        for (const playerId of lobbyPlayerIds) {
                            // Check if player is already in the game
                            const playerObjectId = new mongoose.Types.ObjectId(playerId);
                            const playerInGame = game.players.some(p => p.player_id.equals(playerObjectId));

                            if (!playerInGame) {
                                console.log(`Adding player ${playerId} to game ${gameCode}`);

                                // Add player to game
                                game.players.push({
                                    player_id: playerObjectId,
                                    articles_visited: [],
                                    current_article: null,
                                    artifacts: [],
                                    score: 0,
                                    is_host: false
                                });

                                // Update player's current game
                                try {
                                    const player = await Player.findById(playerId);
                                    if (player) {
                                        player.current_game = game._id;
                                        await player.save();
                                        console.log(`Updated player ${playerId} with game ID ${game._id}`);
                                    }
                                } catch (playerError) {
                                    console.error(`Error updating player ${playerId}:`, playerError);
                                }
                            }
                        }

                        // Save the game first to ensure we have a valid ID
                        await game.save();

                        // Log the valid game ID to confirm it exists
                        console.log('Game saved with ID:', game._id.toString());

                        let articlesDistributed = false;
                        let artifactsDistributed = false;

                        // Distribute random articles
                        const articlesNumber = game.settings?.articles_number || 5;
                        try {
                            // Add a small delay to ensure the game is fully saved before making API calls
                            await new Promise(resolve => setTimeout(resolve, 500));

                            // Use direct API call instead of fetch to avoid potential network issues
                            const articlesResult = await callAPI('/games/random-articles', {
                                id_game: game._id.toString(),
                                number: articlesNumber
                            });

                            console.log('Random articles distributed:', articlesResult);
                            articlesDistributed = true;

                            // Add another small delay before distributing artifacts
                            await new Promise(resolve => setTimeout(resolve, 500));

                            // Distribute artifacts to players
                            const artifactsResult = await callAPI('/games/distribute-artifacts', {
                                id_game: game._id.toString(),
                                enabledArtifacts: event.data.enabledArtifacts || []
                            });

                            console.log('Artifacts distributed:', artifactsResult);
                            artifactsDistributed = true;
                        } catch (error) {
                            console.error('Error distributing game resources:', error);
                            // Continue with game start even if distribution fails
                        }

                        // Create the game start event with stringified ID
                        const gameStartEvent = {
                            type: 'game_start',
                            data: {
                                gameCode: gameCode,
                                gameId: game._id.toString(),
                                articlesDistributed,
                                artifactsDistributed
                            }
                        };

                        // Log the event before returning
                        console.log('Game start processing complete:', JSON.stringify(gameStartEvent));

                        // Don't broadcast here - the WebSocket handler already did that
                        // Just return the event for the WebSocket handler to use

                        // Save game state again after all operations
                        await game.save();

                        return gameStartEvent;
                    } catch (error) {
                        console.error('Error handling game start:', error);
                        // Try to notify clients about the error
                        try {
                            broadcastToLobby(gameCode, {
                                type: 'game_start_error',
                                data: {
                                    message: 'Failed to start game. Please try again.'
                                }
                            });
                        } catch (broadcastError) {
                            console.error('Error broadcasting game start error:', broadcastError);
                        }
                    }
                }
                break;

            case 'player_rename':
                const { playerId: playerIdToRename, newName } = event.data;
                const playerToRename = game.players.find(p => p.player_id.equals(playerIdToRename));
                if (playerToRename) {
                    const player = await Player.findById(playerIdToRename);
                    if (player) {
                        player.pseudo = newName;
                        await player.save();
                        broadcastToLobby(gameCode, {
                            type: 'player_rename',
                            data: {
                                playerId: playerIdToRename.toString(),
                                newName: newName
                            }
                        });
                    }
                }
                break;

            case 'profile_picture_change':
                const { playerId: playerIdToUpdate, pictureUrl, pp_color } = event.data;
                const playerToUpdate = game.players.find(p => p.player_id.equals(playerIdToUpdate));
                if (playerToUpdate) {
                    const player = await Player.findById(playerIdToUpdate);
                    if (player) {
                        player.pp = pictureUrl;
                        player.pp_color = pp_color;
                        await player.save();
                        broadcastToLobby(gameCode, {
                            type: 'profile_picture_change',
                            data: {
                                playerId: playerIdToUpdate.toString(),
                                pictureUrl,
                                pp_color
                            }
                        });
                    }
                }
                break;

            case 'player_ban':
                const banPlayerId = event.data.playerId;
                const banReason = event.data.reason || 'No reason provided';

                // Only host can ban players
                const requestingPlayer = game.players.find(p =>
                    p.player_id && p.player_id.toString() === event.data.hostId
                );

                if (!requestingPlayer || !requestingPlayer.is_host) {
                    console.error(`Ban request denied: Player ${event.data.hostId} is not the host of game ${gameCode}`);
                    return;
                }

                // Check if player is already banned
                const alreadyBanned = game.banned_players.some(p =>
                    p.player_id && p.player_id.toString() === banPlayerId
                );

                if (alreadyBanned) {
                    console.log(`Player ${banPlayerId} is already banned from game ${gameCode}`);
                    // Update the ban reason if provided
                    if (banReason && banReason !== 'No reason provided') {
                        const bannedPlayerIndex = game.banned_players.findIndex(p =>
                            p.player_id && p.player_id.toString() === banPlayerId
                        );
                        if (bannedPlayerIndex !== -1) {
                            game.banned_players[bannedPlayerIndex].reason = banReason;
                            game.banned_players[bannedPlayerIndex].banned_at = new Date();
                        }
                    }
                } else {
                    // Add player to banned list
                    game.banned_players.push({
                        player_id: banPlayerId,
                        reason: banReason,
                        banned_at: new Date()
                    });
                    console.log(`Player ${banPlayerId} has been banned from game ${gameCode}. Reason: ${banReason}`);
                }

                // Find the player in the game
                const bannedPlayerIndex = game.players.findIndex(p =>
                    p.player_id && p.player_id.toString() === banPlayerId
                );

                if (bannedPlayerIndex === -1) {
                    console.log(`Player ${banPlayerId} not found in game ${gameCode}, nothing to remove but ban recorded`);
                } else {
                    // Remove the player from the game
                    game.players.splice(bannedPlayerIndex, 1);
                }

                await game.save();
                break;

            case 'player_kick':
                const kickPlayerId = event.data.playerId;
                const kickReason = event.data.reason || 'No reason provided';

                // Only host can kick players
                const hostPlayer = game.players.find(p =>
                    p.player_id && p.player_id.toString() === event.data.hostId
                );

                if (!hostPlayer || !hostPlayer.is_host) {
                    console.error(`Kick request denied: Player ${event.data.hostId} is not the host of game ${gameCode}`);
                    return;
                }

                // Find the player in the game
                const kickedPlayerIndex = game.players.findIndex(p =>
                    p.player_id && p.player_id.toString() === kickPlayerId
                );

                if (kickedPlayerIndex === -1) {
                    console.log(`Player ${kickPlayerId} not found in game ${gameCode}, nothing to remove`);
                    return;
                }

                // Remove the player from the game
                game.players.splice(kickedPlayerIndex, 1);

                console.log(`Player ${kickPlayerId} has been kicked from game ${gameCode}. Reason: ${kickReason}`);

                await game.save();
                break;
        }

        await game.save();
        console.log(`Game state updated for ${gameCode}`);
    } catch (error) {
        console.error('Error handling game state change:', error);
    }
}

function setupWebSocketServer() {
    // Create WebSocket server on port 4000
    wss = new WebSocketServer({
        port: 4000,
        clientTracking: true,
        perMessageDeflate: {
            zlibDeflateOptions: {
                chunkSize: 1024,
                memLevel: 7,
                level: 3
            },
            zlibInflateOptions: {
                chunkSize: 10 * 1024
            },
            // Below options specified as default values
            concurrencyLimit: 10,
            threshold: 1024 // Size (in bytes) below which messages should not be compressed
        }
    });

    // Set up heartbeat interval to detect dead connections
    const heartbeatInterval = setInterval(() => {
        const now = Date.now();

        // Check each client's last activity
        for (const [client, lastActivity] of clientActivity.entries()) {
            // If no activity for more than 60 seconds, consider the connection dead
            // This is a longer timeout to accommodate page refreshes and brief network issues
            if (now - lastActivity > 60000) {
                console.log('Client inactive for too long, terminating connection');
                try {
                    client.terminate();
                } catch (e) {
                    console.error('Error terminating inactive client:', e);
                }
                clientActivity.delete(client);
            }
        }
    }, 15000); // Check every 15 seconds

    // Handle new WebSocket connections
    wss.on('connection', (ws, req) => {
        console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);

        // Track client activity
        clientActivity.set(ws, Date.now());

        // Store current lobby and player ID for this connection
        let currentLobby = null;
        let currentPlayerId = null;

        // Handle incoming messages
        ws.on('message', async (message) => {
            // Update activity timestamp
            clientActivity.set(ws, Date.now());

            let event;
            try {
                event = JSON.parse(message);
            } catch (error) {
                console.error('Invalid JSON message:', message.toString());
                return;
            }

            // Log non-ping messages
            if (event.type !== 'ping') {
                console.log('Message reçu :', message.toString());
            }

            switch (event.type) {
                case 'player_join':
                    if (event.data && event.data.gameCode) {
                        const gameCode = event.data.gameCode;
                        const playerId = event.data.player?.id;

                        // Check if the player is banned
                        const game = await Game.findOne({ game_code: gameCode });
                        if (game) {
                            const isBanned = game.banned_players.some(p =>
                                p.player_id && p.player_id.toString() === playerId
                            );

                            if (isBanned) {
                                // Get the ban reason
                                const bannedPlayer = game.banned_players.find(p =>
                                    p.player_id && p.player_id.toString() === playerId
                                );
                                const banReason = bannedPlayer ? bannedPlayer.reason : 'No reason provided';

                                console.log(`Banned player ${playerId} attempted to join game ${gameCode}. Reason: ${banReason}`);

                                // Send ban message to player
                                ws.send(JSON.stringify({
                                    type: 'join_banned',
                                    data: {
                                        gameCode,
                                        reason: banReason
                                    }
                                }));

                                return;
                            }
                        }

                        // Check for duplicate join attempts
                        const joinKey = `${playerId}-${gameCode}`;
                        const lastJoinTime = joinAttempts.get(joinKey) || 0;
                        const now = Date.now();

                        // If this is a duplicate join within 5 seconds, ignore it
                        if (now - lastJoinTime < 5000) {
                            console.log(`Ignoring duplicate join attempt for player ${playerId} in lobby ${gameCode} (${(now - lastJoinTime) / 1000}s since last attempt)`);

                            // Still send a success response to prevent client from retrying
                            ws.send(JSON.stringify({
                                type: 'join_success',
                                data: { gameCode, playerId }
                            }));

                            return;
                        }

                        // Record this join attempt
                        joinAttempts.set(joinKey, now);

                        // Check if this is a reconnection after a disconnection
                        const disconnectionKey = `disconnect-${playerId}-${gameCode}`;
                        const lastDisconnectTime = joinAttempts.get(disconnectionKey) || 0;

                        // If the player recently disconnected, treat this as a reconnection
                        if (now - lastDisconnectTime < 30000) {
                            console.log(`Player ${playerId} is reconnecting to lobby ${gameCode} after disconnection (${(now - lastDisconnectTime) / 1000}s ago)`);

                            // Clear any pending leave event processing
                            processedLeaveEvents.delete(`${playerId}-${gameCode}`);
                        }

                        // Clear any processed leave events for this player-lobby pair
                        processedLeaveEvents.delete(`${playerId}-${gameCode}`);

                        // Update current lobby and player ID for this connection
                        currentLobby = gameCode;
                        currentPlayerId = playerId;

                        // Store these values on the WebSocket object for reference
                        ws.currentLobby = gameCode;
                        ws.currentPlayerId = playerId;

                        // Track this player's socket
                        if (playerId) {
                            console.log(`Tracking player ${playerId} in lobby ${gameCode}`);
                            playerSockets.set(playerId, ws);
                        }

                        // Add this connection to the lobby
                        if (!lobbies.has(gameCode)) {
                            lobbies.set(gameCode, new Set());
                        }
                        lobbies.get(gameCode).add(ws);

                        // Debug information about lobbies after adding
                        console.log(`After adding client to lobby ${gameCode}:`);
                        console.log(`Lobby ${gameCode} now has ${lobbies.get(gameCode).size} clients`);
                        console.log(`Current lobbies: ${Array.from(lobbies.keys()).join(', ')}`);

                        // Broadcast the join event to all clients in the lobby
                        broadcastToLobby(gameCode, event, ws);

                        // Update game state
                        await handleGameStateChange(gameCode, event);

                        // Send a success response to confirm the join
                        ws.send(JSON.stringify({
                            type: 'join_success',
                            data: { gameCode, playerId }
                        }));
                    }
                    break;

                case 'player_leave':
                    if (currentLobby) {
                        // Check if the game is in progress
                        const game = await Game.findOne({ game_code: currentLobby });
                        if (!game) {
                            console.log(`Game not found for lobby ${currentLobby}, skipping leave event`);
                            break;
                        }

                        const isGameInProgress = game && game.status === 'in_progress';
                        const playerId = event.data.playerId;

                        // Check if we've already processed a leave event for this player-lobby pair
                        const leaveEventKey = `${playerId}-${currentLobby}`;
                        if (processedLeaveEvents.has(leaveEventKey)) {
                            console.log(`Already processed leave event for player ${playerId} in lobby ${currentLobby}, ignoring duplicate`);
                            return;
                        }

                        // Track leave events to prevent duplicates
                        const leaveKey = `leave-${playerId}-${currentLobby}`;
                        const lastLeaveTime = joinAttempts.get(leaveKey) || 0;
                        const now = Date.now();

                        // If this is a duplicate leave within 5 seconds, ignore it
                        if (now - lastLeaveTime < 5000) {
                            console.log(`Ignoring duplicate leave attempt for player ${playerId} in lobby ${currentLobby} (${(now - lastLeaveTime) / 1000}s since last attempt)`);
                            return;
                        }

                        // Check if this player just joined (within the last 3 seconds)
                        const joinKey = `${playerId}-${currentLobby}`;
                        const lastJoinTime = joinAttempts.get(joinKey) || 0;

                        // If the player just joined within 3 seconds, don't process the leave event
                        if (now - lastJoinTime < 3000) {
                            console.log(`Player ${playerId} just joined lobby ${currentLobby} ${(now - lastJoinTime) / 1000}s ago, ignoring leave event`);
                            return;
                        }

                        // Record this leave attempt
                        joinAttempts.set(leaveKey, now);

                        // Mark that we've processed a leave event for this player-lobby pair
                        processedLeaveEvents.add(leaveEventKey);

                        console.log(`Processing leave event for player ${playerId} in lobby ${currentLobby}`);

                        // Remove from lobby clients
                        const lobbyClients = lobbies.get(currentLobby);
                        if (lobbyClients) {
                            lobbyClients.delete(ws);
                            if (lobbyClients.size === 0) {
                                lobbies.delete(currentLobby);
                            }
                        }

                        // Remove player from tracking
                        if (playerId) {
                            playerSockets.delete(playerId);
                        }

                        // Only broadcast and update game state if game is not in progress
                        // and if we have a valid game and player ID
                        if (!isGameInProgress && game && playerId) {
                            // Check if player is actually in the game before broadcasting
                            const playerInGame = game.players.some(p => p.player_id.toString() === playerId);

                            if (playerInGame) {
                                // Only broadcast if there are clients in the lobby
                                if (lobbies.has(currentLobby) && lobbies.get(currentLobby).size > 0) {
                                    broadcastToLobby(currentLobby, event, ws);
                                } else {
                                    console.log(`No clients in lobby ${currentLobby} to broadcast leave event to`);
                                }

                                try {
                                    await handleGameStateChange(currentLobby, event);
                                } catch (error) {
                                    console.error(`Error handling game state change for leave event:`, error);
                                }
                            } else {
                                console.log(`Player ${playerId} not found in game ${currentLobby}, skipping leave event`);
                            }
                        } else {
                            console.log(`Game ${currentLobby} is in progress or invalid data, not removing player ${playerId}`);
                        }

                        // Reset current lobby and player ID
                        currentLobby = null;
                        currentPlayerId = null;
                    }
                    break;

                case 'settings_update':
                    if (currentLobby) {
                        // For settings updates, broadcast to ALL clients including sender
                        broadcastToLobby(currentLobby, event, null);
                        await handleGameStateChange(currentLobby, event);
                    }
                    break;

                case 'game_start':
                    if (currentLobby) {
                        try {
                            // First, enhance the event with the game ID
                            const game = await Game.findOne({ game_code: currentLobby });
                            if (game) {
                                // Make sure the event includes the game ID
                                if (!event.data) event.data = {};
                                event.data.gameId = game._id.toString();

                                console.log('Enhanced game_start event with ID:', JSON.stringify(event));
                            }

                            // Ensure the lobby exists
                            ensureLobbyExists(currentLobby);

                            // Broadcast the initial game_start event to all clients
                            broadcastToLobby(currentLobby, event, null);

                            // Process the game start (distribute articles, artifacts, etc.)
                            const enhancedEvent = await handleGameStateChange(currentLobby, event);

                            // Ensure the lobby still exists after game start
                            ensureLobbyExists(currentLobby);

                            // If handleGameStateChange returned an enhanced event, broadcast it
                            if (enhancedEvent && enhancedEvent.data &&
                                (enhancedEvent.data.articlesDistributed || enhancedEvent.data.artifactsDistributed)) {
                                console.log('Broadcasting enhanced game_start event with distribution results');
                                broadcastToLobby(currentLobby, enhancedEvent, null);
                            }

                            // Important: Do NOT remove the lobby when the game starts
                            // The lobby is still needed for chat and other communications
                        } catch (error) {
                            console.error('Error processing game_start event:', error);
                            // Notify clients about the error
                            broadcastToLobby(currentLobby, {
                                type: 'game_start_error',
                                data: {
                                    message: 'Failed to start game. Please try again.'
                                }
                            }, null);
                        }
                    }
                    break;

                case 'player_rename':
                    if (currentLobby) {
                        // For rename, broadcast to ALL clients including sender
                        broadcastToLobby(currentLobby, event, null);
                        await handleGameStateChange(currentLobby, event);
                    }
                    break;

                case 'profile_picture_change':
                    if (currentLobby) {
                        broadcastToLobby(currentLobby, event, null);
                        await handleGameStateChange(currentLobby, event);
                    }
                    break;

                case 'chat_message':
                    // For chat messages, we need to be more flexible
                    // The gameCode should be in the event data
                    if (event.data && event.data.gameCode) {
                        const chatGameCode = event.data.gameCode;

                        // Store the game code on the connection if not already set
                        if (!currentLobby) {
                            currentLobby = chatGameCode;
                            ws.currentLobby = chatGameCode;

                            // Add this connection to the lobby if not already there
                            if (!lobbies.has(chatGameCode)) {
                                lobbies.set(chatGameCode, new Set());
                            }
                            if (!lobbies.get(chatGameCode).has(ws)) {
                                lobbies.get(chatGameCode).add(ws);
                                console.log(`Added client to lobby ${chatGameCode} for chat`);
                            }
                        }

                        // Add timestamp if not present
                        if (!event.data.timestamp) {
                            event.data.timestamp = Date.now();
                        }

                        // Add message ID if not present
                        if (!event.data.messageId) {
                            event.data.messageId = `${event.data.playerId}-${event.data.timestamp}-${Math.random().toString(36).substring(2, 10)}`;
                        }

                        // Create a copy of the event for broadcasting
                        const broadcastEvent = JSON.parse(JSON.stringify(event));

                        // Add echo flag to indicate this is a server echo
                        broadcastEvent.data.isServerEcho = true;

                        // Log the chat message (without content for privacy)
                        console.log(`Chat message from ${event.data.playerName || 'Unknown'} in lobby ${chatGameCode} (ID: ${event.data.messageId})`);

                        // Broadcast to ALL clients including the sender (null means no exclusion)
                        broadcastToLobby(chatGameCode, broadcastEvent, null);
                    } else {
                        console.error('Chat message missing gameCode:', event);
                    }
                    break;

                case 'private_message':
                    // For private messages, we send only to the specific recipient
                    if (event.data && event.data.gameCode && event.data.recipientId) {
                        const chatGameCode = event.data.gameCode;
                        const recipientId = event.data.recipientId;
                        const senderId = event.data.playerId;

                        // Add timestamp if not present
                        if (!event.data.timestamp) {
                            event.data.timestamp = Date.now();
                        }

                        // Add message ID if not present
                        if (!event.data.messageId) {
                            event.data.messageId = `${senderId}-${recipientId}-${event.data.timestamp}-${Math.random().toString(36).substring(2, 10)}`;
                        }

                        // Create a copy of the event for sending
                        const privateEvent = JSON.parse(JSON.stringify(event));

                        // Add echo flag to indicate this is a server echo
                        privateEvent.data.isServerEcho = true;

                        console.log(`Private message from ${event.data.senderName || 'Unknown'} to user ${recipientId} in lobby ${chatGameCode}`);

                        // Send to the recipient
                        const recipientSocket = playerSockets.get(recipientId);
                        if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                            recipientSocket.send(JSON.stringify(privateEvent));
                        } else {
                            console.log(`Recipient ${recipientId} is not connected, message not delivered`);
                        }

                        // Send acknowledgment back to the sender
                        ws.send(JSON.stringify({
                            type: 'private_message_sent',
                            data: {
                                messageId: privateEvent.data.messageId,
                                recipientId: recipientId,
                                timestamp: privateEvent.data.timestamp
                            }
                        }));
                    } else {
                        console.error('Private message missing gameCode or recipientId:', event);
                    }
                    break;

                case 'player_kick':
                    if (currentLobby) {
                        // Verify the game exists
                        const game = await Game.findOne({ game_code: currentLobby });
                        if (!game) {
                            console.log(`Game not found for lobby ${currentLobby}, skipping kick event`);
                            break;
                        }

                        // Process the kick
                        await handleGameStateChange(currentLobby, event);

                        // Send kick notification to the kicked player
                        const kickedPlayerId = event.data.playerId;
                        const kickReason = event.data.reason || 'No reason provided';
                        const kickedPlayerSocket = playerSockets.get(kickedPlayerId);

                        if (kickedPlayerSocket && kickedPlayerSocket.readyState === WebSocket.OPEN) {
                            kickedPlayerSocket.send(JSON.stringify({
                                type: 'player_kicked',
                                data: {
                                    gameCode: currentLobby,
                                    reason: kickReason
                                }
                            }));
                        }

                        // Broadcast to everyone else that the player left
                        const leaveEvent = {
                            type: 'player_leave',
                            data: {
                                gameCode: currentLobby,
                                playerId: kickedPlayerId
                            }
                        };

                        broadcastToLobby(currentLobby, leaveEvent, kickedPlayerSocket);
                    }
                    break;

                case 'player_ban':
                    if (currentLobby) {
                        // Verify the game exists
                        const game = await Game.findOne({ game_code: currentLobby });
                        if (!game) {
                            console.log(`Game not found for lobby ${currentLobby}, skipping ban event`);
                            break;
                        }

                        // Process the ban
                        await handleGameStateChange(currentLobby, event);

                        // Send ban notification to the banned player
                        const bannedPlayerId = event.data.playerId;
                        const banReason = event.data.reason || 'No reason provided';
                        const bannedPlayerSocket = playerSockets.get(bannedPlayerId);

                        if (bannedPlayerSocket && bannedPlayerSocket.readyState === WebSocket.OPEN) {
                            bannedPlayerSocket.send(JSON.stringify({
                                type: 'player_banned',
                                data: {
                                    gameCode: currentLobby,
                                    reason: banReason
                                }
                            }));
                        }

                        // Broadcast to everyone else that the player left
                        const leaveEvent = {
                            type: 'player_leave',
                            data: {
                                gameCode: currentLobby,
                                playerId: bannedPlayerId
                            }
                        };

                        broadcastToLobby(currentLobby, leaveEvent, bannedPlayerSocket);
                    }
                    break;
            }
        });

        ws.on("error", (error) => {
            console.error(`WebSocket error for ${req.socket.remoteAddress}:`, error);
        });

        // Handle WebSocket close event
        ws.on('close', async (code, reason) => {
            console.log(`WebSocket closed from ${req.socket.remoteAddress}. Code: ${code}, Reason: ${reason}`);

            // Clean up client activity tracking
            clientActivity.delete(ws);

            // If this is a normal closure due to page unload, don't process it as a leave event
            // and don't remove the client from the lobby
            if (code === 1000 && reason === "Page unload") {
                console.log("Client disconnected due to page unload, not processing as leave event");
                return;
            }

            // Use the values stored on the WebSocket object itself
            // as they're more reliable than the closure variables
            const lobbyCode = ws.currentLobby || currentLobby;
            const playerId = ws.currentPlayerId || currentPlayerId;

            if (lobbyCode) {
                // Debug information before removing
                console.log(`Before removing client from lobby ${lobbyCode}:`);
                if (lobbies.has(lobbyCode)) {
                    console.log(`Lobby ${lobbyCode} has ${lobbies.get(lobbyCode).size} clients`);
                } else {
                    console.log(`Lobby ${lobbyCode} does not exist`);
                }

                // Remove this connection from the lobby
                if (lobbies.has(lobbyCode)) {
                    lobbies.get(lobbyCode).delete(ws);
                    console.log(`After removing client, lobby ${lobbyCode} now has ${lobbies.get(lobbyCode).size} clients`);

                    if (lobbies.get(lobbyCode).size === 0) {
                        lobbies.delete(lobbyCode);
                        console.log(`Removed empty lobby ${lobbyCode}`);
                    }
                }

                if (playerId) {
                    console.log(`Player ${playerId} disconnected from lobby ${lobbyCode}`);

                    // Check if this was the socket associated with the player
                    if (playerSockets.get(playerId) === ws) {
                        playerSockets.delete(playerId);
                    }

                    // Don't immediately process as a leave event - give time for reconnection
                    // Store the disconnection time
                    const disconnectionKey = `disconnect-${playerId}-${lobbyCode}`;
                    joinAttempts.set(disconnectionKey, Date.now());

                    // We'll process the actual leave event after a delay
                    // This allows for reconnection during page refreshes
                    setTimeout(async () => {
                        // Check if the player has reconnected
                        if (playerSockets.has(playerId)) {
                            console.log(`Player ${playerId} reconnected to lobby ${lobbyCode}, not processing leave event`);
                            return;
                        }

                        // Check if we've already processed a leave event for this player-lobby pair
                        const leaveEventKey = `${playerId}-${lobbyCode}`;
                        if (processedLeaveEvents.has(leaveEventKey)) {
                            console.log(`Already processed leave event for player ${playerId} in lobby ${lobbyCode}`);
                            return;
                        }

                        console.log(`Player ${playerId} did not reconnect to lobby ${lobbyCode} within timeout, processing leave event`);

                        // Track leave events to prevent duplicates
                        const leaveKey = `leave-${playerId}-${lobbyCode}`;
                        joinAttempts.set(leaveKey, Date.now());

                        // Mark that we've processed a leave event for this player-lobby pair
                        processedLeaveEvents.add(leaveEventKey);

                        // Check if the game is in progress before handling player leave
                        const game = await Game.findOne({ game_code: lobbyCode });
                        if (game && game.status !== 'in_progress') {
                            // Only create a leave event if the game is not in progress
                            const leaveEvent = {
                                type: 'player_leave',
                                data: {
                                    gameCode: lobbyCode,
                                    playerId: playerId
                                }
                            };

                            // Only broadcast if there are clients in the lobby
                            if (lobbies.has(lobbyCode) && lobbies.get(lobbyCode).size > 0) {
                                broadcastToLobby(lobbyCode, leaveEvent);
                            }

                            // Update game state
                            try {
                                await handleGameStateChange(lobbyCode, leaveEvent);
                            } catch (error) {
                                console.error(`Error handling game state change for leave event:`, error);
                            }
                        }
                    }, 10000); // Wait 10 seconds before processing the leave event
                }
            }
        });
    });

    // Clean up on server shutdown
    process.on('SIGINT', () => {
        clearInterval(heartbeatInterval);
        wss.close();
        process.exit();
    });

    console.log("✅ WebSocket server started on port 4000");
}

function broadcastToLobby(gameCode, event, excludeWs = null) {
    // Don't log ping messages to reduce noise
    if (event.type !== 'ping') {
        console.log(`Broadcasting to lobby ${gameCode}:`, event.type);

        // Debug information about lobbies
        console.log(`Current lobbies: ${Array.from(lobbies.keys()).join(', ')}`);
        if (lobbies.has(gameCode)) {
            console.log(`Lobby ${gameCode} has ${lobbies.get(gameCode).size} clients`);
        } else {
            console.log(`Lobby ${gameCode} does not exist`);

            // Check if there are any player sockets associated with this game code
            // This could happen if the lobby was converted to a game but the clients are still connected
            const playersInGame = Array.from(playerSockets.entries())
                .filter(([_, ws]) => ws.currentLobby === gameCode)
                .map(([playerId, _]) => playerId);

            if (playersInGame.length > 0) {
                console.log(`Found ${playersInGame.length} players still associated with game ${gameCode}`);

                // Recreate the lobby with the existing player sockets
                const newLobby = new Set();
                for (const [playerId, ws] of playerSockets.entries()) {
                    if (ws.currentLobby === gameCode) {
                        newLobby.add(ws);
                    }
                }

                if (newLobby.size > 0) {
                    console.log(`Recreating lobby ${gameCode} with ${newLobby.size} clients`);
                    lobbies.set(gameCode, newLobby);
                }
            }
        }
    }

    // If no lobby exists, nothing to do
    if (!lobbies.has(gameCode) || lobbies.get(gameCode).size === 0) {
        if (event.type !== 'ping') {
            console.log(`No clients in lobby ${gameCode}, skipping broadcast`);
        }
        return;
    }

    // Prepare the message once
    const message = JSON.stringify(event);

    // For ping messages, use a simpler approach
    if (event.type === 'ping') {
        const invalidClients = new Set();

        lobbies.get(gameCode).forEach(client => {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                } catch (e) {
                    invalidClients.add(client);
                }
            }
        });

        // Remove invalid clients
        if (invalidClients.size > 0) {
            invalidClients.forEach(client => {
                lobbies.get(gameCode).delete(client);
            });
            console.log(`Removed ${invalidClients.size} disconnected clients from lobby ${gameCode}`);
        }

        return;
    }

    // For non-ping messages, track success and failure
    const validClients = new Set();
    const invalidClients = new Set();

    // First identify valid and invalid clients
    lobbies.get(gameCode).forEach(client => {
        if (client !== excludeWs) {
            if (client.readyState === WebSocket.OPEN) {
                validClients.add(client);
            } else {
                invalidClients.add(client);
            }
        }
    });

    // Log the client count
    if (event.type === 'chat_message') {
        console.log(`Broadcasting chat message to ${validClients.size} clients in lobby ${gameCode}`);
    } else {
        console.log(`Found ${validClients.size + invalidClients.size} clients in lobby`);
    }

    // Remove invalid clients
    invalidClients.forEach(client => {
        console.log(`Skipping client with readyState: ${client.readyState}`);
        lobbies.get(gameCode).delete(client);
    });

    if (invalidClients.size > 0) {
        console.log(`Removed ${invalidClients.size} disconnected clients from lobby ${gameCode}`);
    }

    // Send to all valid clients
    let sentCount = 0;
    let failedCount = 0;

    validClients.forEach(client => {
        try {
            client.send(message);
            sentCount++;
        } catch (e) {
            console.error(`Error sending message to client:`, e);
            failedCount++;
        }
    });

    if (event.type === 'chat_message') {
        console.log(`Chat message sent to ${sentCount} clients, failed to send to ${failedCount} clients`);
    } else {
        console.log(`Sent message to ${sentCount} clients, failed to send to ${failedCount} clients`);
    }
}

// Connexion MongoDB
mongoose
    .connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000
    })
    .then(() => {
        console.log("✅ MongoDB connected successfully");

        // Start HTTP server
        app.listen(PORT, () => {
            console.log(`✅ HTTP server listening on http://localhost:${PORT}`);
        });

        // Start WebSocket server on port 4000
        setupWebSocketServer();
    })
    .catch((err) => {
        console.error("❌ MongoDB connection error:", err);
        console.log("⚠️  Make sure MongoDB is running on your system or update the MONGODB_URI in your .env file");
        process.exit(1);
    });

// Routes API
app.use("/players", playerRoutes);
app.use("/games", gameRoutes);
app.use("/articles", articleRoutes);
app.use("/artifacts", artifactRoutes);
app.use("/challenges", challengeRoutes);

cron.schedule('1 0 * * *', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    try {
        const existing = await Challenge.findOne({ date: dateOnly });
        if (existing) {
            console.log('❌ Challenge du jour déjà créé');
            return;
        }

        const destination_article = (await postRequest("https://apiwikigame.abdelrahimriche.com/challenges/create-challenge")).title;

        const challenge = new Challenge({
            date: today,
            destination_article,
            players: []
        });

        await challenge.save();
        console.log(`✅ Challenge créé pour ${dateOnly.toISOString().slice(0, 10)} avec l'article "${destination_article}"`);
    } catch (err) {
        console.error('🔥 Erreur lors de la création du challenge :', err.message);
    }
});

// Tâche cron pour supprimer les jeux publics non terminés après 1 jour - EXÉCUTION À 23h10
cron.schedule('10 23 * * *', async () => { // Exécuté à 23h10 chaque jour
    try {
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);

        // Supprimer les jeux publics qui ne sont pas 'finished' et créés il y a plus de 1 jour
        const result = await Game.deleteMany({
            'settings.visibility': 'public',
            start_time: { $lt: oneDayAgo }
        });

        console.log(`✅ ${result.deletedCount} jeux publics non terminés supprimés (critère: 1 jour d'ancienneté)`);
    } catch (err) {
        console.error('🔥 Erreur lors de la suppression des jeux publics anciens :', err.message);
    }
});

// Debug route to check if server is responding
app.get("/debug", (req, res) => {
    res.json({ message: "Server is running correctly" });
});

// Log all registered routes
console.log("Registered routes:");
app._router.stack.forEach(middleware => {
    if (middleware.route) {
        // Routes registered directly on the app
        console.log(`${Object.keys(middleware.route.methods)} ${middleware.route.path}`);
    } else if (middleware.name === 'router') {
        // Routes registered on a router
        middleware.handle.stack.forEach(handler => {
            if (handler.route) {
                const path = handler.route.path;
                const methods = Object.keys(handler.route.methods);
                console.log(`${methods} ${middleware.regexp} ${path}`);
            }
        });
    }
});

async function callAPI(endpoint, body, retryCount = 0) {
    try {
        console.log(`Calling API ${endpoint} with body:`, body);
        const response = await fetch(`https://apiwikigame.abdelrahimriche.com${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Error ${response.status} from ${endpoint}:`, errorText);

            // Check if this is a version conflict error and we haven't exceeded retry attempts
            if (errorText.includes('VersionError') && retryCount < 3) {
                console.log(`Version conflict detected, retrying (attempt ${retryCount + 1}/3)...`);
                // Wait a short time before retrying to allow other operations to complete
                await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
                return callAPI(endpoint, body, retryCount + 1);
            }

            throw new Error(`API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log(`Response from ${endpoint}:`, data);
        return data;
    } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
        throw error; // Re-throw to allow caller to handle
    }
}

async function testAPI() {
    try {
        console.log("Testing API endpoints...");
        // await callAPI("/games/players", { id_game: "67b1f4c36fe85f560dd86791" });
        // await callAPI("/games/artifacts", {id_game: "67b1f4c36fe85f560dd86791", id_player: "67a7bc84385c3dc88d87a747"});
        // await callAPI("/games/current-article", {id_game: "67b1f4c36fe85f560dd86791", id_player: "67a7bc84385c3dc88d87a747"});
        // await callAPI("/games/distribute-artifacts", {id_game: "67b1f4c36fe85f560dd86791"});
        await callAPI("/games/storable-artifacts", { id_game: "67b1f4c36fe85f560dd86791" });
        //await callAPI("/games/mine-artifact", {id_game: "67cc3a2ee84c208199f2c767", id_player: '67cc3a2ee84c208199f2c764'});
        console.log("API tests completed successfully");
    } catch (error) {
        console.error("API test failed:", error);
    }
}

app.get("/", (req, res) => {
    res.send("API fonctionne !");
});

// Helper function to ensure a lobby exists for a game code
function ensureLobbyExists(gameCode) {
    if (!lobbies.has(gameCode)) {
        console.log(`Creating lobby for game ${gameCode}`);
        lobbies.set(gameCode, new Set());
    }

    // Check if there are any player sockets associated with this game code
    // that aren't already in the lobby
    for (const [playerId, ws] of playerSockets.entries()) {
        if (ws.currentLobby === gameCode && !lobbies.get(gameCode).has(ws)) {
            console.log(`Adding player ${playerId}'s socket to lobby ${gameCode}`);
            lobbies.get(gameCode).add(ws);
        }
    }

    return lobbies.get(gameCode);
}