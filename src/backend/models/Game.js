import mongoose from 'mongoose';

const GameSchema = new mongoose.Schema({
    game_code: String,
    status: String,
    start_time: Date,
    end_time: Date,
    challenge_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Challenge', default: null },
    settings: {
        max_players: Number,
        time_limit: Number,
        articles_number: Number,
        visibility: String,
        allow_join: Boolean,
        enabled_artifacts: [String]
    },
    players: [
        {
            player_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
            articles_visited: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
            found_target_articles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
            current_article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
            dictateArticle: String,
            artifacts: [String],
            score: Number,
            is_host: Boolean
        }
    ],
    banned_players: [
        {
            player_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
            reason: String,
            banned_at: { type: Date, default: Date.now }
        }
    ],
    mined_article: [String],
    articles_to_visit: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
});

export default mongoose.model('Game', GameSchema);