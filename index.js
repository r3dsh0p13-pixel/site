const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

// Configuration - À METTRE DANS UN FICHIER .env EN PRODUCTION !
const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || '1431031931025231992';
const CATEGORY_ID = process.env.CATEGORY_ID || '1431031975694696498';
const CLIENT_ID = '1432381161400959120'; // Ton Application ID

// Initialisation
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Base de données
const db = new Database('avis_system.db');

// Création des tables
db.exec(`
    CREATE TABLE IF NOT EXISTS stock_avis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lien TEXT NOT NULL,
        texte TEXT NOT NULL,
        date_ajout DATETIME DEFAULT CURRENT_TIMESTAMP,
        en_cours INTEGER DEFAULT 0,
        user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS avis_soumis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        stock_id INTEGER NOT NULL,
        lien_avis TEXT NOT NULL,
        lien_original TEXT NOT NULL,
        texte_original TEXT NOT NULL,
        date_soumission DATETIME DEFAULT CURRENT_TIMESTAMP,
        statut TEXT DEFAULT 'en_attente',
        FOREIGN KEY (stock_id) REFERENCES stock_avis(id)
    );

    CREATE TABLE IF NOT EXISTS paiements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        adresse_ltc TEXT NOT NULL,
        nombre_avis INTEGER NOT NULL,
        montant REAL NOT NULL,
        date_demande DATETIME DEFAULT CURRENT_TIMESTAMP,
        date_paiement_due DATETIME NOT NULL,
        statut TEXT DEFAULT 'en_attente',
        notif_envoyee INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tickets (
        user_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        actif INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    );
`);

// Ajouter les utilisateurs par défaut
const checkUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (checkUsers.count === 0) {
    db.prepare('INSERT INTO users (user_id, username, password, role) VALUES (?, ?, ?, ?)').run('admin', 'admin', 'admin123', 'admin');
    db.prepare('INSERT INTO users (user_id, username, password, role) VALUES (?, ?, ?, ?)').run('fournisseur', 'fournisseur', 'fournisseur123', 'fournisseur');
}

// Définir les slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('start_avis')
        .setDescription('Commencer à faire des avis'),
    
    new SlashCommandBuilder()
        .setName('add_stock')
        .setDescription('Ajouter un avis au stock (Admin)')
        .addStringOption(option =>
            option.setName('lien')
                .setDescription('Le lien de l\'avis')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('texte')
                .setDescription('Le texte de l\'avis')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('view_stock')
        .setDescription('Voir le stock d\'avis disponibles (Admin)'),
    
    new SlashCommandBuilder()
        .setName('remove_stock')
        .setDescription('Supprimer un avis du stock (Admin)')
        .addIntegerOption(option =>
            option.setName('id')
                .setDescription('L\'ID de l\'avis à supprimer')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Voir les statistiques (Admin)'),
    
    new SlashCommandBuilder()
        .setName('payments')
        .setDescription('Voir les paiements en attente (Admin)')
].map(command => command.toJSON());

// Serveur web
app.use(express.static('public'));
app.use(express.json());

// API Routes
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
    
    if (user) {
        res.json({ success: true, role: user.role, userId: user.user_id });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/stats', (req, res) => {
    const stats = {
        stock: db.prepare('SELECT COUNT(*) as count FROM stock_avis WHERE en_cours = 0').get().count,
        avis_soumis: db.prepare('SELECT COUNT(*) as count FROM avis_soumis WHERE statut = ?').get('en_attente').count,
        paiements_attente: db.prepare('SELECT COUNT(*) as count FROM paiements WHERE statut = ?').get('en_attente').count,
        total_paye: db.prepare('SELECT COALESCE(SUM(montant), 0) as total FROM paiements WHERE statut = ?').get('paye').total
    };
    res.json(stats);
});

app.get('/api/avis', (req, res) => {
    const avis = db.prepare(`
        SELECT a.*, s.lien as lien_original, s.texte as texte_original 
        FROM avis_soumis a 
        LEFT JOIN stock_avis s ON a.stock_id = s.id 
        ORDER BY a.date_soumission DESC
    `).all();
    res.json(avis);
});

app.get('/api/paiements', (req, res) => {
    const paiements = db.prepare('SELECT * FROM paiements ORDER BY date_demande DESC').all();
    res.json(paiements);
});

app.get('/api/stock', (req, res) => {
    const stock = db.prepare('SELECT * FROM stock_avis ORDER BY date_ajout DESC').all();
    res.json(stock);
});

app.post('/api/paiement/valider/:id', (req, res) => {
    db.prepare('UPDATE paiements SET statut = ? WHERE id = ?').run('paye', req.params.id);
    io.emit('update');
    res.json({ success: true });
});

app.get('/api/fournisseur/:userId', (req, res) => {
    const avis = db.prepare('SELECT * FROM avis_soumis WHERE user_id = ? ORDER BY date_soumission DESC').all(req.params.userId);
    const paiements = db.prepare('SELECT * FROM paiements WHERE user_id = ? ORDER BY date_demande DESC').all(req.params.userId);
    res.json({ avis, paiements });
});

// Fonctions helper
function getNextAvis() {
    return db.prepare('SELECT * FROM stock_avis WHERE en_cours = 0 LIMIT 1').get();
}

function marquerAvisEnCours(id, userId) {
    db.prepare('UPDATE stock_avis SET en_cours = 1, user_id = ? WHERE id = ?').run(userId, id);
}

function libererAvis(id) {
    db.prepare('UPDATE stock_avis SET en_cours = 0, user_id = NULL WHERE id = ?').run(id);
}

function sauvegarderAvis(userId, username, stockId, lienAvis, lienOriginal, texteOriginal) {
    return db.prepare('INSERT INTO avis_soumis (user_id, username, stock_id, lien_avis, lien_original, texte_original) VALUES (?, ?, ?, ?, ?, ?)').run(userId, username, stockId, lienAvis, lienOriginal, texteOriginal);
}

function creerPaiement(userId, username, adresseLtc, nombreAvis) {
    const montant = nombreAvis * 0.50;
    const dateDue = new Date();
    dateDue.setDate(dateDue.getDate() + 2);
    
    return db.prepare('INSERT INTO paiements (user_id, username, adresse_ltc, nombre_avis, montant, date_paiement_due) VALUES (?, ?, ?, ?, ?, ?)').run(userId, username, adresseLtc, nombreAvis, montant, dateDue.toISOString());
}

// Bot Discord
client.on('ready', async () => {
    console.log(`✅ Bot connecté : ${client.user.tag}`);
    
    // Enregistrer les slash commands
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    try {
        console.log('🔄 Enregistrement des slash commands...');
        
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );
        
        console.log('✅ Slash commands enregistrées !');
    } catch (error) {
        console.error('❌ Erreur enregistrement commands:', error);
    }
    
    // Vérifier les paiements toutes les heures
    setInterval(verifierPaiements, 3600000);
});

async function verifierPaiements() {
    const maintenant = new Date().toISOString();
    const paiementsDus = db.prepare('SELECT * FROM paiements WHERE statut = ? AND date_paiement_due <= ? AND notif_envoyee = 0').all('en_attente', maintenant);
    
    for (const paiement of paiementsDus) {
        try {
            const user = await client.users.fetch(paiement.user_id);
            const admin = await client.users.fetch(ADMIN_ID);
            
            const embed = new EmbedBuilder()
                .setTitle('💰 Paiement à effectuer')
                .setColor('#FFD700')
                .addFields(
                    { name: 'Utilisateur', value: paiement.username },
                    { name: "Nombre d'avis", value: paiement.nombre_avis.toString() },
                    { name: 'Montant', value: `${paiement.montant}€` },
                    { name: 'Adresse LTC', value: paiement.adresse_ltc }
                )
                .setTimestamp();
            
            await user.send({ embeds: [embed], content: '⏰ Les 2 jours sont écoulés ! Ton paiement est prêt.' });
            await admin.send({ embeds: [embed], content: '⏰ Paiement à effectuer !' });
            
            db.prepare('UPDATE paiements SET notif_envoyee = 1 WHERE id = ?').run(paiement.id);
        } catch (error) {
            console.error('Erreur notification paiement:', error);
        }
    }
}

// Gestion des slash commands
client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
        
        // /start_avis - Pour tous
        if (commandName === 'start_avis') {
            const ticket = db.prepare('SELECT * FROM tickets WHERE user_id = ? AND actif = 1').get(interaction.user.id);
            
            if (ticket) {
                return interaction.reply({ content: '❌ Tu as déjà un ticket actif !', ephemeral: true });
            }
            
            const avis = getNextAvis();
            
            if (!avis) {
                return interaction.reply({ content: "❌ Plus d'avis disponibles pour le moment", ephemeral: true });
            }
            
            try {
                const channel = await interaction.guild.channels.create({
                    name: `ticket-${interaction.user.username}`,
                    type: ChannelType.GuildText,
                    parent: CATEGORY_ID,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id,
                            deny: [PermissionFlagsBits.ViewChannel]
                        },
                        {
                            id: interaction.user.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                        },
                        {
                            id: ADMIN_ID,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                        }
                    ]
                });
                
                db.prepare('INSERT INTO tickets (user_id, channel_id) VALUES (?, ?)').run(interaction.user.id, channel.id);
                marquerAvisEnCours(avis.id, interaction.user.id);
                
                const embed = new EmbedBuilder()
                    .setTitle('📝 Nouvel avis à faire')
                    .setColor('#00FF00')
                    .addFields(
                        { name: '🔗 Lien', value: avis.lien },
                        { name: '📄 Texte à mettre', value: avis.texte }
                    )
                    .setFooter({ text: 'Envoie le lien de ton avis une fois terminé' });
                
                await channel.send({ content: `<@${interaction.user.id}>`, embeds: [embed] });
                await interaction.reply({ content: `✅ Ticket créé : <#${channel.id}>`, ephemeral: true });
                
            } catch (error) {
                console.error('Erreur création ticket:', error);
                interaction.reply({ content: '❌ Erreur lors de la création du ticket', ephemeral: true });
            }
            return;
        }
        
        // Commandes admin uniquement
        if (interaction.user.id !== ADMIN_ID) {
            return interaction.reply({ content: '❌ Cette commande est réservée aux administrateurs', ephemeral: true });
        }
        
        // /add_stock
        if (commandName === 'add_stock') {
            const lien = interaction.options.getString('lien');
            const texte = interaction.options.getString('texte');
            
            db.prepare('INSERT INTO stock_avis (lien, texte) VALUES (?, ?)').run(lien, texte);
            io.emit('update');
            
            return interaction.reply({ content: '✅ Avis ajouté au stock !', ephemeral: true });
        }
        
        // /view_stock
        if (commandName === 'view_stock') {
            const stock = db.prepare('SELECT * FROM stock_avis WHERE en_cours = 0').all();
            
            if (stock.length === 0) {
                return interaction.reply({ content: '❌ Stock vide', ephemeral: true });
            }
            
            const embed = new EmbedBuilder()
                .setTitle("📦 Stock d'avis disponibles")
                .setColor('#00FF00')
                .setDescription(stock.map(a => `**ID ${a.id}:** ${a.lien}\n*${a.texte.substring(0, 50)}...*`).join('\n\n'));
            
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        
        // /remove_stock
        if (commandName === 'remove_stock') {
            const id = interaction.options.getInteger('id');
            db.prepare('DELETE FROM stock_avis WHERE id = ?').run(id);
            io.emit('update');
            return interaction.reply({ content: '✅ Avis supprimé du stock', ephemeral: true });
        }
        
        // /stats
        if (commandName === 'stats') {
            const stats = {
                stock: db.prepare('SELECT COUNT(*) as count FROM stock_avis WHERE en_cours = 0').get().count,
                enCours: db.prepare('SELECT COUNT(*) as count FROM stock_avis WHERE en_cours = 1').get().count,
                soumis: db.prepare('SELECT COUNT(*) as count FROM avis_soumis').get().count,
                paiements: db.prepare('SELECT COUNT(*) as count FROM paiements WHERE statut = ?').get('en_attente').count
            };
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Statistiques')
                .setColor('#0099FF')
                .addFields(
                    { name: '📦 Stock disponible', value: stats.stock.toString(), inline: true },
                    { name: '⏳ En cours', value: stats.enCours.toString(), inline: true },
                    { name: '✅ Avis soumis', value: stats.soumis.toString(), inline: true },
                    { name: '💰 Paiements en attente', value: stats.paiements.toString(), inline: true }
                );
            
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        
        // /payments
        if (commandName === 'payments') {
            const paiements = db.prepare('SELECT * FROM paiements WHERE statut = ?').all('en_attente');
            
            if (paiements.length === 0) {
                return interaction.reply({ content: '✅ Aucun paiement en attente', ephemeral: true });
            }
            
            const embed = new EmbedBuilder()
                .setTitle('💰 Paiements en attente')
                .setColor('#FFD700')
                .setDescription(paiements.map(p => {
                    const dateDue = new Date(p.date_paiement_due);
                    const maintenant = new Date();
                    const heuresRestantes = Math.max(0, Math.round((dateDue - maintenant) / 3600000));
                    
                    return `**${p.username}**\nAvis: ${p.nombre_avis} | Montant: ${p.montant}€\nAdresse LTC: \`${p.adresse_ltc}\`\n⏰ ${heuresRestantes}h restantes`;
                }).join('\n\n'));
            
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
    
    // Gestion des boutons
    if (interaction.isButton()) {
        const [action, ...args] = interaction.customId.split('_');
        
        if (action === 'avis' && args[0] === 'envoye') {
            const stockId = args[1];
            const lienAvis = args.slice(2).join('_');
            
            const avis = db.prepare('SELECT * FROM stock_avis WHERE id = ?').get(stockId);
            sauvegarderAvis(interaction.user.id, interaction.user.username, stockId, lienAvis, avis.lien, avis.texte);
            
            // Supprimer l'avis du stock
            db.prepare('DELETE FROM stock_avis WHERE id = ?').run(stockId);
            io.emit('update');
            
            const embed = new EmbedBuilder()
                .setTitle('🎉 Merci !')
                .setColor('#00FF00')
                .setDescription('Ton avis a été validé.\n\nQue veux-tu faire ?');
            
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('continuer')
                        .setLabel('➡️ Continuer')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('finaliser')
                        .setLabel('💰 Finaliser & Paiement')
                        .setStyle(ButtonStyle.Success)
                );
            
            await interaction.update({ embeds: [embed], components: [row] });
        }
        
        if (action === 'bloque') {
            const stockId = args[0];
            libererAvis(stockId);
            
            db.prepare('UPDATE tickets SET actif = 0 WHERE user_id = ?').run(interaction.user.id);
            
            await interaction.update({ 
                content: '⚠️ Avis remis en stock. Ticket fermé.', 
                embeds: [], 
                components: [] 
            });
            
            setTimeout(() => interaction.channel.delete(), 5000);
            io.emit('update');
        }
        
        if (interaction.customId === 'continuer') {
            const avis = getNextAvis();
            
            if (!avis) {
                await interaction.update({ 
                    content: "❌ Plus d'avis disponibles pour le moment", 
                    embeds: [], 
                    components: [] 
                });
                return;
            }
            
            marquerAvisEnCours(avis.id, interaction.user.id);
            
            const embed = new EmbedBuilder()
                .setTitle('📝 Nouvel avis à faire')
                .setColor('#00FF00')
                .addFields(
                    { name: '🔗 Lien', value: avis.lien },
                    { name: '📄 Texte à mettre', value: avis.texte }
                )
                .setFooter({ text: 'Envoie le lien de ton avis une fois terminé' });
            
            await interaction.update({ embeds: [embed], components: [] });
        }
        
        if (interaction.customId === 'finaliser') {
            const modal = new ModalBuilder()
                .setCustomId('modal_ltc')
                .setTitle('💰 Adresse Litecoin');
            
            const input = new TextInputBuilder()
                .setCustomId('adresse_ltc')
                .setLabel('Ton adresse LTC')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('LTC1abc...')
                .setRequired(true);
            
            const row = new ActionRowBuilder().addComponents(input);
            modal.addComponents(row);
            
            await interaction.showModal(modal);
        }
    }
    
    // Gestion des modals
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_ltc') {
            const adresseLtc = interaction.fields.getTextInputValue('adresse_ltc');
            
            const nombreAvis = db.prepare('SELECT COUNT(*) as count FROM avis_soumis WHERE user_id = ? AND statut = ?').get(interaction.user.id, 'en_attente').count;
            
            if (nombreAvis === 0) {
                await interaction.reply({ content: '❌ Aucun avis à payer', ephemeral: true });
                return;
            }
            
            creerPaiement(interaction.user.id, interaction.user.username, adresseLtc, nombreAvis);
            db.prepare('UPDATE avis_soumis SET statut = ? WHERE user_id = ? AND statut = ?').run('paiement_demande', interaction.user.id, 'en_attente');
            db.prepare('UPDATE tickets SET actif = 0 WHERE user_id = ?').run(interaction.user.id);
            
            const montant = nombreAvis * 0.50;
            
            const embed = new EmbedBuilder()
                .setTitle('✅ Demande de paiement enregistrée')
                .setColor('#FFD700')
                .addFields(
                    { name: "📊 Nombre d'avis", value: nombreAvis.toString() },
                    { name: '💰 Montant total', value: `${montant}€` },
                    { name: '🔑 Adresse LTC', value: adresseLtc },
                    { name: '⏰ Paiement dans', value: '2 jours' }
                )
                .setFooter({ text: 'Tu recevras une notification quand le paiement sera effectué' });
            
            await interaction.reply({ embeds: [embed] });
            
            setTimeout(() => interaction.channel.delete(), 10000);
            io.emit('update');
            
            // Notif admin
            try {
                const admin = await client.users.fetch(ADMIN_ID);
                await admin.send({ embeds: [embed], content: '🔔 Nouvelle demande de paiement !' });
            } catch (error) {
                console.error('Erreur notification admin:', error);
            }
        }
    }
});

// Messages dans les tickets
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Vérifier si message dans un ticket
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND actif = 1').get(message.channel.id);
    
    if (ticket && message.author.id === ticket.user_id) {
        // L'utilisateur a envoyé le lien de son avis
        if (message.content.startsWith('http')) {
            const avisEnCours = db.prepare('SELECT * FROM stock_avis WHERE user_id = ? AND en_cours = 1').get(message.author.id);
            
            if (!avisEnCours) {
                return message.reply('❌ Aucun avis en cours');
            }
            
            const embed = new EmbedBuilder()
                .setTitle('✅ Avis reçu')
                .setColor('#00FF00')
                .setDescription('Ton avis a bien été enregistré !\n\nChoisis une option :');
            
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`avis_envoye_${avisEnCours.id}_${message.content}`)
                        .setLabel('✅ Avis envoyé')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`bloque_${avisEnCours.id}`)
                        .setLabel('⚠️ Bloqué par le système')
                        .setStyle(ButtonStyle.Danger)
                );
            
            await message.reply({ embeds: [embed], components: [row] });
        }
    }
});

// Démarrage
client.login(TOKEN);
server.listen(3000, () => {
    console.log('🌐 Serveur web démarré sur le port 3000');
});