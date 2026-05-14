const { TikTokLive } = require('./node_modules/@tiktool/live/dist/index.js');
const express = require('express');
const http = require('http');
const fs = require('fs').promises; // For async file operations
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===============================
// SETTINGS
// ===============================
const TIKTOOL_API_KEY = "tk_91ec88c2870958d10d58fbcfe4e73840d018705e201a96c1";
const TARGET_USERNAME = "king_kaly"; // Put your username here
const POINTS_PER_LAP = 100;

const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

// All country data is now right here - no config.json needed!
let countriesList = [
    { id: 1, name: "Nigeria", flag: "ng", gift: "Rose", giftIcon: "/assets/gifts/rose.png", wins: 0, score: 0, currentPos: 0 },
    { id: 2, name: "Ghana", flag: "gh", gift: "Love you so much", giftIcon: "/assets/gifts/loveyou.png", wins: 0, score: 0, currentPos: 0 },
    { id: 3, name: "USA", flag: "us", gift: "GG", giftIcon: "/assets/gifts/gg.png", wins: 0, score: 0, currentPos: 0 },
    { id: 4, name: "Canada", flag: "ca", gift: "Ice Cream Cone", giftIcon: "/assets/gifts/icecream.png", wins: 0, score: 0, currentPos: 0 },
    { id: 5, name: "UK", flag: "gb", gift: "Cake Slice", giftIcon: "/assets/gifts/cake.png", wins: 0, score: 0, currentPos: 0 },
    { id: 6, name: "Germany", flag: "de", gift: "Wink Wink", giftIcon: "/assets/gifts/winkwink.png", wins: 0, score: 0, currentPos: 0 },
    { id: 7, name: "India", flag: "in", gift: "Freestyle", giftIcon: "/assets/gifts/freestyle.png", wins: 0, score: 0, currentPos: 0 },
    { id: 8, name: "Saudi Arabia", flag: "sa", gift: "Oldies", giftIcon: "/assets/gifts/oldie.png", wins: 0, score: 0, currentPos: 0 },
    { id: 9, name: "Australia", flag: "au", gift: "Pop", giftIcon: "/assets/gifts/pop.png", wins: 0, score: 0, currentPos: 0 },
    { id: 10, name: "China", flag: "cn", gift: "You're awesome", giftIcon: "/assets/gifts/youawesome.png", wins: 0, score: 0, currentPos: 0 },
    { id: 11, name: "South Africa", flag: "za", gift: "TikTok", giftIcon: "/assets/gifts/tiktok.png", wins: 0, score: 0, currentPos: 0 },
    { id: 12, name: "Tanzania", flag: "tz", gift: "Glow Stick", giftIcon: "/assets/gifts/glowstick.png", wins: 0, score: 0, currentPos: 0 }
];


app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));

// Global storage object to prevent race conditions and file corruption
let storageData = {
    totalUniqueGifters: 0,
    totalGifts: 0,
    totalUnconfiguredGifts: 0,
    gifts: []
};

// In-memory set to track unique gifters for the current session
let uniqueGifters = new Set();

// The advanced tracker from the other code
let giftComboTracker = {};

// ✅ FIX: Serialized Save to prevent "ENOENT" Race Conditions during high concurrency
let isSaving = false;
let saveQueued = false;
async function atomicSave() {
    if (isSaving) {
        saveQueued = true;
        return;
    }
    isSaving = true;
    saveQueued = false;
    try {
        const tempPath = STORAGE_FILE + ".tmp";
        await fs.writeFile(tempPath, JSON.stringify(storageData, null, 2));
        await fs.rename(tempPath, STORAGE_FILE);
    } catch (err) {
        console.error("❌ Error writing to storage.json:", err);
    } finally {
        isSaving = false;
        if (saveQueued) atomicSave(); // Perform the queued save with latest memory data
    }
}

// Helper to get current ranking
const getRankedList = () => {
    const sorted = [...countriesList].sort((a, b) => {
        // Primary sort: Wins (Laps completed)
        if (b.wins !== a.wins) return b.wins - a.wins;
        // Secondary sort: Score (Progress in current lap)
        return b.score - a.score;
    });

    return sorted.map(country => ({
        ...country,
        // Requirement: Show "Waiting..." if they haven't completed a lap yet
        winStatus: country.wins > 0 ? country.wins : 0
    }));
};

// Function to initialize or reset storage.json for a new session
async function initializeStorage() {
    try {
        // Ensure data directory exists
        await fs.mkdir(DATA_DIR, { recursive: true });

        // Check if storage.json exists from a previous session
        try {
            const stats = await fs.stat(STORAGE_FILE);
            // Only archive if the file exists and is NOT empty (prevents 300+ file spam)
            if (stats.size < 100) throw new Error("Empty file");

            // If it exists, rename it to archive
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const archiveFileName = path.join(DATA_DIR, `storage_${timestamp}.json`);
            await fs.rename(STORAGE_FILE, archiveFileName);
            console.log(`📊 Archived previous session data to: ${archiveFileName}`);
        } catch (error) {
            // storage.json does not exist, no need to rename
        }

        // Create a new empty storage.json for the current session
        storageData = {
            totalUniqueGifters: 0,
            totalGifts: 0,
            totalUnconfiguredGifts: 0,
            gifts: []
        };
        await fs.writeFile(STORAGE_FILE, JSON.stringify(storageData, null, 2));
        console.log(`📊 New session storage created: ${STORAGE_FILE}`);
        
        // Reset in-memory unique gifters for the new session
        uniqueGifters.clear();

    } catch (err) {
        console.error("❌ Error initializing storage:", err);
    }
}

// ===============================
// TIKTOK CONNECTION LOGIC
// ===============================
const tiktok = new TikTokLive({
    uniqueId: TARGET_USERNAME,
    apiKey: TIKTOOL_API_KEY,
    autoReconnect: true,
    signServerUrl: "https://api.tik.tools"
});

tiktok.on('gift', async (data) => {
    try {
        if (!data) return;
        
        // ✅ Fix: Use uniqueId for tracking to prevent cross-user score bugs
        const trackingId = `${data.user.uniqueId}_${data.giftName}`;
        const now = Date.now();
        let record = giftComboTracker[trackingId] || { count: 0, ts: 0 };
        let countToProcess = 0;

        if (data.repeatCount === 1) {
            // If we recently saw a high count for this gift, this x1 is likely a late-arriving start packet.
            // We ignore it to prevent resetting the tracker and double-counting when the rest of the combo follows.
            if (now - record.ts < 2000 && record.count > 1) return;
            
            countToProcess = 1;
            giftComboTracker[trackingId] = { count: 1, ts: now };
        } else if (data.repeatCount > record.count) {
            // Continuation of a combo: add the difference between current total and what we last saw.
            countToProcess = data.repeatCount - record.count;
            giftComboTracker[trackingId] = { count: data.repeatCount, ts: now };
        } else {
            // Duplicate packet or late intermediate packet (e.g. seeing x10 then x12 then x10 again)
            return;
        }

        // Clean up tracking when combo ends, but check timestamps to ensure we don't delete a NEWER combo's data
        if (data.repeatEnd) setTimeout(() => { 
            const current = giftComboTracker[trackingId];
            if (current && current.ts <= now) delete giftComboTracker[trackingId]; 
        }, 5000);

        if (countToProcess <= 0) return;

        const country = countriesList.find(c => c.gift.toLowerCase() === data.giftName.toLowerCase());

        // 1. Update Memory Storage (Log everything, even unconfigured gifts)
        storageData.totalGifts += countToProcess;
        
        // Increment unconfigured counter if no country matches
        if (!country) {
            storageData.totalUnconfiguredGifts += countToProcess;
        }

        storageData.gifts.push({
            timestamp: new Date().toISOString(),
            username: data.user.uniqueId,
            nickname: data.user.nickname,
            giftName: data.giftName,
            amount: countToProcess,
            country: country ? country.name : "Unconfigured" // Mark unconfigured gifts as "Unconfigured"
        });

        if (!uniqueGifters.has(data.user.uniqueId)) {
            uniqueGifters.add(data.user.uniqueId);
            storageData.totalUniqueGifters = uniqueGifters.size;
        }

        // 2. Save to file (Asynchronous write using the memory object)
        // atomicSave handles concurrency internally to prevent ENOENT errors
        atomicSave();

        if (!country) {
            console.warn(`⚠️ Gift "${data.giftName}" from ${data.user.uniqueId} not configured for any country.`);
            return;
        }

        // ✅ Only log and update race if the gift belongs to a country
        console.log(`🎁 ${data.user.uniqueId} sent ${data.giftName} x${data.repeatCount} (Adding +${countToProcess} for ${country.name})`);

        country.score += countToProcess;
        country.wins = Math.floor(country.score / POINTS_PER_LAP);
        country.currentPos = ((country.score % POINTS_PER_LAP) / POINTS_PER_LAP) * 100;

        io.emit('updateRace', {
            allCountries: countriesList, // Stays in original 1-20 order
            topRank: getRankedList()      // Sorted for the leaderboard
        });

    } catch (err) {
        console.error("❌ GIFT ERROR:", err);
    }
});
            



tiktok.on('connected', () => console.log(`✅ Game Connected: ${TARGET_USERNAME}`));
tiktok.on('error', (err) => console.error("❌ TIKTOK ERROR:", err));

io.on('connection', (socket) => {
    // Send the current state immediately when a user connects/refreshes
    socket.emit('updateRace', { 
        allCountries: countriesList,
        topRank: getRankedList()
    });
});

// New async startup function to ensure proper order of operations
async function startServer() {
    try {
        await initializeStorage(); // Ensure storage is ready first
    } catch (err) {
        console.error("❌ Failed to initialize storage. Server will not start.", err);
        return;
    }

    // Connect TikTok after storage is ready
    tiktok.connect().catch((err) => console.error("❌ TikTok connection failed:", err));

    server.listen(3000, () => {
        console.log("🚀 SERVER READY: http://localhost:3000");
    });
}

startServer(); // Call the async startup function
