//@ts-strict-ignore
// Node.js
import fs from "node:fs";
import crypto from "node:crypto";
import { Buffer } from 'node:buffer';
import PouchDB from 'pouchdb';
// Databases
import Nano from "nano";
import Database from 'better-sqlite3';
// Networking & Server
import express from "express";
import cors from "cors";
import proxy from "express-http-proxy";
import expressPouchDB from "express-pouchdb";
import session from "express-session";
import { WebSocketServer } from "ws";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import config from "../../config.js";
// Misc
import _ from "lodash";
import { expand, compact } from './snapshots.js';
import nodePandoc from "node-pandoc";
import URLSafeBase64 from "urlsafe-base64";
import * as uuid from "uuid";
import hlc from "@tpp/hybrid-logical-clock";
import Debug from "debug";
const debug = Debug('cards');
import morgan from "morgan";
/* ==== SQLite3 ==== */
const db = new Database('../data/data.sqlite');
db.pragma('journal_mode = WAL');
// Litestream Recommendations
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
// Users Table
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT, password TEXT, createdAt INTEGER, confirmedAt INTEGER, paymentStatus TEXT, language TEXT)');
const userByEmail = db.prepare('SELECT * FROM users WHERE id = ?');
const userByRowId = db.prepare('SELECT * FROM users WHERE rowid = ?');
const userSignup = db.prepare('INSERT INTO users (id, salt, password, createdAt, confirmedAt, paymentStatus, language) VALUES (?, ?, ?, ?, ?, ?, ?)');
const userConfirm = db.prepare('UPDATE users SET confirmedAt = ? WHERE id = ?');
const userChangePassword = db.prepare('UPDATE users SET salt = ?, password = ? WHERE id = ?');
const userSetLanguage = db.prepare('UPDATE users SET language = ? WHERE id = ?');
const userSetPaymentStatus = db.prepare('UPDATE users SET paymentStatus = ? WHERE id = ?');
const expireTestUser = db.prepare("UPDATE users SET paymentStatus='trial:' || CAST(1000*(unixepoch() - 2*24*60*60) AS TEXT) WHERE id = 'cypress@testing.com'");
// Reset Token Table
db.exec('CREATE TABLE IF NOT EXISTS resetTokens (token TEXT PRIMARY KEY, email TEXT, createdAt INTEGER)');
const resetToken = db.prepare('SELECT * FROM resetTokens WHERE token = ?');
const resetTokenInsert = db.prepare('INSERT INTO resetTokens (token, email, createdAt) VALUES (?, ?, ?)');
const resetTokenDelete = db.prepare('DELETE FROM resetTokens WHERE email = ?');
// Trees Table
db.exec('CREATE TABLE IF NOT EXISTS trees (id TEXT PRIMARY KEY, name TEXT, location TEXT, owner TEXT, collaborators TEXT, inviteUrl TEXT, createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER)');
db.exec('CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, treeId TEXT, content TEXT, parentId TEXT, position FLOAT, updatedAt TEXT, deleted BOOLEAN)');
db.exec('CREATE INDEX IF NOT EXISTS cards_treeId ON cards (treeId)');
db.exec('CREATE TABLE IF NOT EXISTS tree_snapshots ( snapshot TEXT, treeId TEXT, id TEXT, content TEXT, parentId TEXT, position REAL, updatedAt TEXT, delta BOOLEAN)');
db.exec('CREATE INDEX IF NOT EXISTS tree_snapshots_treeId ON tree_snapshots (treeId)');
const treesByOwner = db.prepare('SELECT * FROM trees WHERE owner = ?');
const treeOwner = db.prepare('SELECT owner FROM trees WHERE id = ?').pluck();
const treesModdedBeforeWithSnapshots = db.prepare('SELECT DISTINCT t.id FROM trees t JOIN tree_snapshots ts ON t.id = ts.treeId WHERE ts.delta = 0 AND t.updatedAt < ? ORDER BY t.updatedAt ASC');
const treeUpsert = db.prepare('INSERT OR REPLACE INTO trees (id, name, location, owner, collaborators, inviteUrl, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const upsertMany = db.transaction((trees) => {
    for (const tree of trees) {
        treeUpsert.run(tree.id, tree.name, tree.location, tree.owner, tree.collaborators, tree.inviteUrl, tree.createdAt, tree.updatedAt, tree.deletedAt);
    }
});
// Cards Table
const cardsSince = db.prepare('SELECT * FROM cards WHERE treeId = ? AND updatedAt > ? ORDER BY updatedAt ASC');
const cardsAllUndeleted = db.prepare('SELECT * FROM cards WHERE treeId = ? AND deleted = FALSE ORDER BY updatedAt ASC');
const cardById = db.prepare('SELECT * FROM cards WHERE id = ?');
const cardInsert = db.prepare('INSERT OR REPLACE INTO cards (updatedAt, id, treeId, content, parentId, position, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)');
const cardUpdate = db.prepare('UPDATE cards SET updatedAt = ?, content = ? WHERE id = ?');
const cardUpdateTs = db.prepare('UPDATE cards SET updatedAt = ? WHERE id = ?');
const cardMove = db.prepare('UPDATE cards SET updatedAt = ?, parentId = ?, position = ? WHERE id = ?');
const cardDelete = db.prepare('UPDATE cards SET updatedAt = ?, deleted = TRUE WHERE id = ?');
const cardUndelete = db.prepare('UPDATE cards SET deleted = FALSE WHERE id = ?');
// Tree Snapshots Table
const takeSnapshotSQL = db.prepare(`
INSERT INTO tree_snapshots (snapshot, treeId, id, content, parentId, position, updatedAt, delta)
SELECT
 (SELECT substr(updatedAt, 1, instr(updatedAt, ':') - 1) as updatedAtTime 
  FROM cards WHERE treeId = @treeId AND deleted != 1 ORDER BY updatedAtTime DESC LIMIT 1
 ) || \':\' || treeId, treeId, id, content, parentId, position, updatedAt, 0
FROM cards WHERE treeId = @treeId AND deleted != 1
`);
const getSnapshots = db.prepare('SELECT * FROM tree_snapshots WHERE treeId = ? ORDER BY snapshot ASC');
const getSnapshotIds = db.prepare('SELECT DISTINCT snapshot FROM tree_snapshots WHERE treeId = ? ORDER BY updatedAt DESC');
const treeIdsWithSnapshots = db.prepare('SELECT DISTINCT treeId FROM tree_snapshots');
const removeSnapshot = db.prepare('DELETE FROM tree_snapshots WHERE snapshot = ? AND treeId = ?');
const removeSnapshots = db.prepare('DELETE FROM tree_snapshots WHERE treeId = ? AND snapshot NOT IN (SELECT value FROM json_each(?))');
const insertSnapshotDeltaRow = db.prepare('INSERT INTO tree_snapshots (snapshot, treeId, id, content, parentId, position, updatedAt, delta) VALUES (@snapshot, @treeId, @id, @content, @parentId, @position, @updatedAt, 1);');
const runCompactions = db.transaction((compactions) => {
    for (const compaction of compactions) {
        removeSnapshot.run(compaction.snapshot, compaction.treeId);
        for (const row of compaction.compactedData) {
            insertSnapshotDeltaRow.run(row);
        }
    }
});
//@ts-ignore
const compactTreesTx = db.transaction((treeIds) => {
    for (const treeId of treeIds) {
        debug(`Compacting tree ${treeId}`);
        const snapshots = getSnapshots.all(treeId);
        if (snapshots.length > 0) {
            const compactions = compact(snapshots);
            if (compactions.length > 0) {
                debug(`Compacting ${compactions.length} snapshots for tree ${treeId}`);
                runCompactions(compactions);
                debug(`Compacted ${compactions.length} snapshots for tree ${treeId}`);
            }
        }
    }
});
const compactAllBefore = function (timestamp) {
    const treeIds = treesModdedBeforeWithSnapshots.all(timestamp).map((row) => row.id);
    debug(`Compacting ${treeIds.length} trees`);
    if (treeIds.length > 0) {
        compactTreesTx.immediate(treeIds);
    }
};
const decimateTreeSnapshots = function (treeId, desiredSnapshotsPerTreeId) {
    const totalSnapshots = db.prepare('SELECT COUNT(DISTINCT snapshot) FROM tree_snapshots WHERE treeId = ?').pluck().get(treeId);
    const N = Math.max(1, Math.floor(totalSnapshots / desiredSnapshotsPerTreeId));
    const snapshotIds = getSnapshotIds.all(treeId).map((row) => row.snapshot);
    // Filter these IDs to retain only every Nth ID
    const retainedSnapshotIds = snapshotIds.filter((_, index) => index % N === 0);
    console.log(retainedSnapshotIds);
    // Delete the snapshots that are not in the retained list for the current treeId
    removeSnapshots.run(treeId, JSON.stringify(retainedSnapshotIds));
};
const decimateAllSnapshots = function (desiredSnapshotsPerTreeId) {
    const treeIds = treeIdsWithSnapshots.all().map((row) => row.treeId);
    for (const treeId of treeIds) {
        decimateTreeSnapshots(treeId, desiredSnapshotsPerTreeId);
    }
};
_.mixin({
    memoizeDebounce: function (func, wait = 0, options = {}) {
        var mem = _.memoize(function () {
            return _.debounce(func, wait, options);
        }, options.resolver);
        return function () { mem.apply(this, arguments).apply(this, arguments); };
    }
});
//@ts-ignore
const takeSnapshotDebounced = _.memoizeDebounce((treeId) => {
    debug(`Taking snapshot for tree ${treeId}`);
    takeSnapshotSQL.run({ treeId });
}, 15 * 1000 /* 15 seconds */, { maxWait: 150 * 1000 /* 150 seconds */ });
/* ==== SETUP ==== */
const app = express();
// const appPouchDB = express();
const port = process.env.PORT || 3000;
const port1 = process.env.PORT || 3001;
app.use(cors());
// appPouchDB.use(cors());
// Use morgan to log requests in immediate mode:
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version"', { "immediate": true }));
// Use morgan to log responses separately:
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :response-time ms'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
// sgMail.setApiKey(config.SENDGRID_API_KEY);
/* ==== Start Server ==== */
const nano = Nano(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@127.0.0.1:5984`);
// const nano = Nano({url:`http://localhost:3000//db`, parseUrl: false});
// const nano = Nano({ url: `http://localhost:5984`, parseUrl: false });
const server = app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`));
// const server1 = appPouchDB.listen(port1, () => console.log(`Example app listening at https://localhost:${port1}`));
var TempPouchDB = PouchDB.defaults({ prefix: '../data/pouch' });
// app.use('/db', expressPouchDB(TempPouchDB));
// Session
// const RedisStore = redisConnect(session);
// const redis = createClient({legacyMode: true});
const sessionParser = session({
    // store: new RedisStore({ client: redis }),
    secret: "config.SESSION_SECRET",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: /* 14 days */ 1209600000 }
});
// redis.connect().catch(console.error);
// redis.on("error", function (err) {
//   console.error("Redis Error " + err);
// });
// redis.on("connect", function () {
//   console.log("Redis connected");
// });
app.use(sessionParser);
/* ==== WebSocket ==== */
const wss = new WebSocketServer({ noServer: true });
// const wss = new WebSocketServer({server});
const wsToUser = new Map();
const userToWs = new Map();
wss.on('connection', (ws, req) => {
    console.log("ws connection", req.session);
    const userId = req.session.user;
    wsToUser.set(ws, userId);
    // Add ws to user's entry in userToWs
    if (userToWs.has(userId)) {
        userToWs.get(userId).add(ws);
    }
    else {
        userToWs.set(userId, new Set([ws]));
    }
    const userDataUnsafe = userByEmail.get(userId);
    if (userDataUnsafe && userDataUnsafe.paymentStatus) {
        const userData = _.omit(userDataUnsafe, ['salt', 'password']);
        ws.send(JSON.stringify({ t: "user", d: userData }));
    }
    ws.send(JSON.stringify({ t: "trees", d: treesByOwner.all(userId) }));
    ws.on('message', function incoming(message) {
        try {
            const msg = JSON.parse(message);
            switch (msg.t) {
                case "trees":
                    upsertMany(msg.d);
                    ws.send(JSON.stringify({ t: "treesOk", d: msg.d.sort((a, b) => a.createdAt - b.createdAt)[0].updatedAt }));
                    const usersToNotify = msg.d.map(tree => tree.owner);
                    for (const [otherWs, userId] of wsToUser) {
                        if (usersToNotify.includes(userId) && otherWs !== ws) {
                            //console.log('also sending via notification')
                            otherWs.send(JSON.stringify({ t: "trees", d: treesByOwner.all(userId) }));
                        }
                    }
                    break;
                case 'pull':
                    if (msg.d[1] == '0') {
                        const cards = cardsAllUndeleted.all(msg.d[0]);
                        ws.send(JSON.stringify({ t: 'cards', d: cards }));
                    }
                    else {
                        const cards = cardsSince.all(msg.d[0], msg.d[1]);
                        ws.send(JSON.stringify({ t: 'cards', d: cards }));
                    }
                    break;
                case 'push':
                    // No need for permissions check, as the conflict resolution will take care of it
                    const lastTsRecvd = msg.d.dlts[msg.d.dlts.length - 1].ts;
                    debug('push recvd ts: ', lastTsRecvd);
                    const treeId = msg.d.tr;
                    // Note : If I'm not generating any hybrid logical clock values,
                    // then having this here is likely pointless.
                    hlc.recv(lastTsRecvd);
                    const savedTs = [];
                    const deltasTx = db.transaction(() => {
                        for (let delta of msg.d.dlts) {
                            let savedTsInDelta = runDelta(treeId, delta, userId);
                            savedTs.push(...savedTsInDelta);
                        }
                    });
                    try {
                        deltasTx.immediate();
                        takeSnapshotDebounced(treeId);
                        if (savedTs.length === 0) {
                            throw new Error('Transaction passed but no cards saved');
                        }
                        debug('pushOk : ', savedTs);
                        ws.send(JSON.stringify({ t: 'pushOk', d: savedTs }));
                        const owner = treeOwner.get(treeId);
                        const usersToNotify = [owner];
                        for (const [otherWs, userId] of wsToUser) {
                            if (usersToNotify.includes(userId) && otherWs !== ws) {
                                otherWs.send(JSON.stringify({ t: "doPull", d: treeId }));
                            }
                        }
                    }
                    catch (e) {
                        if (e instanceof ConflictError) {
                            const cards = cardsSince.all(msg.d.tr, msg.d.chk);
                            debug('conflict cards: ', cards.map(c => c.updatedAt));
                            if (cards.length === 0 && e.conflict) {
                                cards.push(e.conflict);
                            }
                            ws.send(JSON.stringify({ t: 'cardsConflict', d: cards, e: e }));
                        }
                        else {
                            ws.send(JSON.stringify({ t: 'pushError', d: e }));
                            axios.post(config.NTFY_URL, e.message).catch(e => console.error(e));
                            console.error(e);
                        }
                        debug(e.message);
                    }
                    break;
                case 'pullHistoryMeta': {
                    const treeId = msg.d;
                    const history = getSnapshots.all(treeId);
                    const historyMeta = _.chain(history)
                        .groupBy('snapshot')
                        .mapValues(s => ({ id: s[0].snapshot, ts: s[0].snapshot }))
                        .values()
                        .value();
                    ws.send(JSON.stringify({ t: 'historyMeta', d: historyMeta, tr: treeId }));
                    break;
                }
                case 'pullHistory': {
                    const treeId = msg.d;
                    const history = getSnapshots.all(treeId);
                    const expandedHistory = expand(history);
                    const historyData = _.chain(expandedHistory)
                        .groupBy('snapshot')
                        .mapValues(s => ({ id: s[0].snapshot, ts: s[0].snapshot, d: s }))
                        .values()
                        .value();
                    ws.send(JSON.stringify({ t: 'history', d: historyData, tr: treeId }));
                    break;
                }
                case 'setLanguage':
                    userSetLanguage.run(msg.d, userId);
                    ws.send(JSON.stringify({ t: 'userSettingOk', d: ['language', msg.d] }));
                    break;
            }
        }
        catch (e) {
            console.error(e);
        }
    });
    ws.on('close', () => {
        wsToUser.delete(ws);
        const userWsSet = userToWs.get(userId);
        if (userWsSet) {
            userWsSet.delete(ws);
            if (userWsSet.size === 0) {
                userToWs.delete(userId);
            }
        }
    });
});
wss.on('error', (err) => {
    console.error(err);
});
server.on('upgrade', async (request, socket, head) => {
    sessionParser(request, {}, (err) => {
        if (err) {
            console.error('Session retrieval error:', err);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        if (request.session && request.session.user) {
            console.log("Connected");

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        }
        else {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
    });
});
/* ==== Authentication ==== */
const iterations = 10;
const keylen = 20;
const encoding = 'hex';
const digest = 'SHA1';
app.post('/signup', async (req, res) => {
    const email = req.body.email.toLowerCase();
    const password = req.body.password;
    let didSubscribe = req.body.subscribed;
    let userDbName = `userdb-${toHex(email)}`;
    const timestamp = Date.now();
    const confirmTime = didSubscribe ? null : timestamp;
    const trialExpiry = timestamp + 10000 * 24 * 3600 * 1000;
    const salt = crypto.randomBytes(16).toString('hex');
    let hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString(encoding);
    try {
        let userInsertInfo = userSignup.run(email, salt, hash, timestamp, confirmTime, "trial:" + trialExpiry, "en");
        const user = userByRowId.get(userInsertInfo.lastInsertRowid);
        req.session.regenerate((err) => {
            if (err) {
                console.error(err);
            }
            req.session.user = email;
            req.session.save(async (err) => {
                if (err) {
                    console.error(err);
                }
                var nano2 = nano;
                await (nano2.db || nano2.server.db).create(userDbName);
                await nano.request({ db: userDbName, method: 'put', path: '_security', body: { members: { names: [email], roles: ['users'] } } });
                //@ts-ignore
                let data = _.omit(user, ['id', 'email', 'password', 'salt']);
                data.email = user.id;
                res.status(200).send(data);
            });
        });
    }
    catch (e) {
        if (e.code && e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
            console.error(e);
            res.status(409).send();
        }
        else {
            console.error(e);
            res.status(500).send({ error: "Internal server error" });
        }
    }
});
app.post('/login', async (req, res) => {
    let email = req.body.email.toLowerCase();
    let password = req.body.password;
    // Check SQLite DB for user and password
    let user = userByEmail.get(email);
    if (user !== undefined) {
        crypto.pbkdf2(password, user.salt, iterations, keylen, digest, (err, derivedKey) => {
            if (err)
                throw err;
            if (derivedKey.toString(encoding) === user.password) {
                // Authentication successful
                try {
                    doLogin(req, res, user);
                }
                catch (loginErr) {
                    console.error(loginErr);
                }
            }
            else {
                res.status(401).send();
            }
        });
    }
    else {
        // User not found
        res.status(401).send();
    }
});
function doLogin(req, res, user) {
    req.session.regenerate(function (err) {
        if (err) {
            console.log(err);
        }
        req.session.user = user.id;
        req.session.save(async (err) => {
            if (err) {
                console.log(err);
            }
            const userTrees = treesByOwner.all(user.id);
            let data = _.omit(user, ['id', 'email', 'password', 'salt']);
            data.email = user.id;
            data.documents = userTrees;
            res.status(200).send(data);
        });
    });
}
app.post('/logout', async (req, res) => {
    if (req.session.user) {
        req.session.destroy((err) => {
            if (err) {
                console.log(err);
            }
            res.clearCookie("connect.sid").status(200).send();
        });
    }
    else {
        res.status(200).send();
    }
});
app.post('/forgot-password', async (req, res) => {
    let email = req.body.email;
    try {
        let user = userByEmail.run(email);
        let token = newToken();
        user.resetToken = hashToken(token); // Consider not hashing token for test user, so we can check it
        user.tokenCreatedAt = Date.now();
        resetTokenInsert.run(user.resetToken, email, user.tokenCreatedAt);
        const msg = {
            to: email,
            from: config.SUPPORT_EMAIL,
            subject: 'Password Reset link for Gingkowriter.com',
            text: `The reset link: https://app.gingkowriter.com/reset-password/${token}`,
            html: `The reset link: https://app.gingkowriter.com/reset-password/${token}`
        };
        await sgMail.send(msg);
        res.status(200).send({ email: email });
    }
    catch (err) {
        console.error(err);
        res.status(err.statusCode).send();
    }
});
app.post('/reset-password', async (req, res) => {
    let token = req.body.token;
    let newPassword = req.body.password;
    try {
        let tokenRow = resetToken.get(hashToken(token));
        if (!tokenRow) {
            res.status(404).send();
            return;
        }
        let timeElapsed = Date.now() - tokenRow.createdAt;
        if (timeElapsed < 3600000) {
            let user = userByEmail.get(tokenRow.email);
            if (user) {
                const salt = crypto.randomBytes(16).toString('hex');
                let hash = crypto.pbkdf2Sync(newPassword, salt, iterations, keylen, digest).toString(encoding);
                userChangePassword.run(salt, hash, user.id);
                const updatedUser = userByEmail.get(tokenRow.email);
                doLogin(req, res, updatedUser);
            }
            else {
                res.status(404).send();
            }
        }
        else {
            res.status(403).send();
        }
        // Whether the token is expired or not, delete it from the database
        resetTokenDelete.run(tokenRow.email);
    }
    catch (err) {
        console.error(err);
        res.status(err.response.status).send(err.response.data);
    }
});
/* ==== DB proxy ==== */
app.use('/db', proxy('http://127.0.0.1:5984', {
    proxyReqOptDecorator: function (proxyReqOpts, srcReq) {
        console.log(srcReq.session.user)
        if (srcReq.session.user) {
            proxyReqOpts.headers['X-Auth-CouchDB-UserName'] = srcReq.session.user;
            proxyReqOpts.headers['X-Auth-CouchDB-Roles'] = '';
            proxyReqOpts.headers['X-Auth-CouchDB-Token'] = 'ec04d0ba4a48bce79f743bab786f9571665169d01948d090f58238dd2cacf64d';
        } else {
            //console.log('No user in session for /db', srcReq);
        }
        return proxyReqOpts;
    }
}));
/* ==== Contact Us Route ==== */
app.post('/pleasenospam', async (req, res) => {
    const msg = {
        to: req.body.toEmail,
        from: config.SUPPORT_EMAIL,
        replyTo: req.body.fromEmail,
        cc: req.body.fromEmail,
        subject: req.body.subject,
        text: req.body.body,
        html: req.body.body,
    };
    const urgentAutoresponse = {
        to: req.body.fromEmail,
        from: config.SUPPORT_URGENT_EMAIL,
        subject: config.URGENT_MESSAGE_SUBJECT,
        html: config.URGENT_MESSAGE_BODY,
    };
    try {
        await sgMail.send(msg);
        if (req.body.toEmail == config.SUPPORT_URGENT_EMAIL) {
            await sgMail.send(urgentAutoresponse);
        }
        res.status(201).send();
    }
    catch (err) {
        console.error(err.response.body);
        res.status(err.code || 400).send(err.response.body);
    }
});
/* ==== Mail confirmation ==== */
let confirmedHandler = (email) => {
    userConfirm.run(Date.now(), email);
    sendUpdatedUserData(email);
};
app.post('/mlhooks', async (req, res) => {
    let events = req.body.events;
    // Handle the events
    let subscribers = events.map(x => x.data.subscriber);
    subscribers.filter(s => s.confirmation_timestamp).map(s => {
        if (s.confirmation_timestamp) {
            confirmedHandler(s.email);
        }
    });
    // Return a res to acknowledge receipt of the event
    res.json({ received: true });
});
/* ==== Export ==== */
app.post('/export-docx', async (req, res) => {
    // receive Markdown string, return file download of docx
    let srcFile = `./${req.body.docId}.tmp.md`;
    let outFile = `${req.body.docId}.docx`;
    res.header('Content-Type', 'application/octet-stream; charset=utf-8');
    fs.writeFile(srcFile, req.body.markdown, () => {
        let args = ['-f', 'markdown', '-t', 'docx', '-o', outFile];
        nodePandoc(srcFile, args, () => {
            fs.createReadStream(outFile).pipe(res);
        });
    });
});
app.get('/utils/compact', (req, res) => {
    if (req.hostname === 'localhost' || req.hostname === '127.0.0.1') {
        const daysAgo = req.query.daysAgo;
        const timestamp = Date.now() - (daysAgo * 24 * 60 * 60 * 1000);
        debug(`Compacting all trees before ${timestamp}`);
        compactAllBefore(timestamp);
        res.send("Compacting");
    }
    else {
        res.status(403).send("Forbidden");
    }
});
app.get('/utils/decimate', (req, res) => {
    if (req.hostname === 'localhost' || req.hostname === '127.0.0.1') {
        const numSnapshots = req.query.num;
        debug(`Decimating all trees to ${numSnapshots} snapshots`);
        decimateAllSnapshots(numSnapshots);
        res.send("Decimating");
    }
    else {
        res.status(403).send("Forbidden");
    }
});
/* ==== Static ==== */
app.use(express.static("../web"));
/* ==== Single Page App ==== */
// Respond to all non-file requests with index.html
app.get('*', (req, res) => {
    const index = new URL('../../web/index.html', import.meta.url).pathname;
    res.sendFile(index);
});
/* ==== Delta Handlers ==== */
class ConflictError extends Error {
    conflict;
    constructor(message, conflict) {
        super(message); // pass the message up to the Error constructor
        // Set the prototype explicitly to allow instanceof checks to work correctly
        // since TypeScript doesn't set the prototype automatically when extending native JavaScript classes
        Object.setPrototypeOf(this, ConflictError.prototype);
        // This line is necessary to get the correct stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ConflictError);
        }
        this.conflict = conflict;
        this.name = 'ConflictError'; // custom name for your error
    }
}
function runDelta(treeId, delta, userId) {
    const ts = delta.ts;
    const savedTs = [];
    if (delta.ops.length === 0) {
        savedTs.push(runUpdTs(ts, delta.id));
        return savedTs;
    }
    for (let op of delta.ops) {
        switch (op.t) {
            case 'i':
                savedTs.push(runIns(ts, treeId, userId, delta.id, op));
                break;
            case 'u':
                savedTs.push(runUpd(ts, delta.id, op));
                break;
            case 'm':
                savedTs.push(runMov(ts, delta.id, op));
                break;
            case 'd':
                savedTs.push(runDel(ts, delta.id, op));
                break;
            case 'ud':
                savedTs.push(runUndel(ts, delta.id));
                break;
        }
    }
    return savedTs;
}
function runIns(ts, treeId, userId, id, ins) {
    // To prevent insertion of cards to trees the user shouldn't have access to
    let userTrees = treesByOwner.all(userId);
    if (!userTrees.map(t => t.id).includes(treeId)) {
        throw new ConflictError(`User ${userId} doesn't have access to tree ${treeId}`);
    }
    const parentPresent = ins.p == null || cardById.get(ins.p);
    if (parentPresent) {
        cardInsert.run(ts, id, treeId, ins.c, ins.p, ins.pos, 0);
        debug(`${ts}: Inserted card ${id.slice(0, 10)} at ${ins.p ? ins.p.slice(0, 10) : ins.p} with ${JSON.stringify(ins.c.slice(0, 20))}`);
        return ts;
    }
    else {
        throw new ConflictError(`Ins Conflict : Parent ${ins.p} not present`);
    }
}
function runUpd(ts, id, upd) {
    const card = cardById.get(id);
    if (card != null && card.updatedAt == upd.e) { // card is present and timestamp is as expected
        cardUpdate.run(ts, upd.c, id);
        debug(`${ts}: Updated card ${id} to ${JSON.stringify(upd.c.slice(0, 20))}`);
        return ts;
    }
    else if (card == null) {
        throw new ConflictError(`Upd Conflict : Card '${id}' not present.`);
    }
    else if (card.updatedAt != upd.e) {
        let msg = `Upd Conflict : Card '${id}' timestamp mismatch : ${card.updatedAt} != ${upd.e}`;
        throw new ConflictError(msg, card);
    }
    else {
        throw new ConflictError(`Upd Conflict : Card '${id}' unknown error`);
    }
}
function runMov(ts, id, mov) {
    const parentPresent = mov.p == null || cardById.get(mov.p) != null;
    const card = cardById.get(id);
    if (card != null && parentPresent && !isAncestor(id, mov.p)) {
        cardMove.run(ts, mov.p, mov.pos, id);
        debug(`${ts}: Moved card ${id} to ${mov.p} at ${mov.pos}`);
        return ts;
    }
    else if (card == null) {
        throw new ConflictError(`Mov Conflict : Card ${id} not present`);
    }
    else if (!parentPresent) {
        throw new ConflictError(`Mov Conflict : Parent ${mov.p} not present`);
    }
    else if (isAncestor(id, mov.p)) {
        throw new ConflictError(`Mov Conflict : Card ${id} is an ancestor of ${mov.p}`);
    }
    else {
        throw new ConflictError(`Mov Conflict : Card ${id} unknown error`);
    }
}
function runDel(ts, id, del) {
    const card = cardById.get(id);
    if (card != null && card.updatedAt == del.e) {
        cardDelete.run(ts, id);
        debug(`${ts}: Deleted card ${id}`);
        return ts;
    }
    else if (card == null) {
        throw new ConflictError(`Del Conflict : Card '${id}' not present`);
    }
    else if (card.updatedAt != del.e) {
        let msg = `Del Conflict : Card '${id}' timestamp mismatch : ${card.updatedAt} != ${del.e}`;
        throw new ConflictError(msg, card);
    }
    else {
        throw new ConflictError(`Del Conflict : Card '${id}' unknown error`);
    }
}
function runUndel(ts, id) {
    const info = cardUndelete.run(id);
    if (info.changes == 0) {
        throw new ConflictError('Undel Conflict : Card not present');
    }
    debug(`${ts}: Undeleted card ${id}`);
    return ts;
}
function runUpdTs(ts, id) {
    const info = cardUpdateTs.run(ts, id);
    if (info.changes == 0) {
        throw new ConflictError('UpdTs Conflict : Card not present');
    }
    debug(`${ts}: Updated card ${id} timestamp to ${ts}`);
    return ts;
}
// --- Helpers ---
function isAncestor(cardId, targetParentId) {
    if (targetParentId == null) {
        return false;
    }
    else if (cardId == targetParentId) {
        return false;
    }
    else {
        const parent = cardById.get(targetParentId);
        return isAncestor(cardId, parent.parentId);
    }
}
/* === HELPERS === */
function sendUpdatedUserData(email) {
    const userDataUnsafe = userByEmail.get(email);
    const userData = _.omit(userDataUnsafe, ['salt', 'password']);
    const userWebSockets = userToWs.get(email);
    if (userWebSockets) {
        userWebSockets.forEach(ws => {
            ws.send(JSON.stringify({ t: "user", d: userData }));
        });
    }
}
function toHex(str) {
    return Buffer.from(str).toString('hex');
}
function newToken() {
    return URLSafeBase64.encode(uuid.v4(null, new Buffer(16)));
}
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
//# sourceMappingURL=index.js.map