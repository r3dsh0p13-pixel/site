// ====== CONFIGURATION ======
const BOT_TOKEN = process.env.TOKEN; 
const ADMIN_PASSWORD = "150410";
const FOURNISSEUR_PASSWORD = "akosh.922";
const PORT = 3000;
const LTC_ADDRESS = "LbcfECZSwFcgC3YiiqmiPiPHXEqiiwGx2N";
const ADMIN_DISCORD_ID = "1421233178797936782";
// ============================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  Routes, 
  REST, 
  InteractionType, 
  ChannelType 
} = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ====== SAUVEGARDE DES AVIS ======
const AVIS_FILE = './avis.json';
let avis = [];
let avisIdCounter = 1;

try {
  if (!fs.existsSync(AVIS_FILE)) fs.writeFileSync(AVIS_FILE, "[]");
  const data = fs.readFileSync(AVIS_FILE, 'utf-8');
  avis = JSON.parse(data);
  if (avis.length > 0) avisIdCounter = avis[avis.length - 1].id + 1;
  console.log(`📁 ${avis.length} avis chargés depuis ${AVIS_FILE}`);
} catch (err) {
  console.error('❌ Erreur lecture avis.json, création fichier vide.', err);
  avis = [];
  avisIdCounter = 1;
  fs.writeFileSync(AVIS_FILE, "[]");
}

function saveAvis() {
  try {
    fs.writeFileSync(AVIS_FILE, JSON.stringify(avis, null, 2), 'utf-8');
    console.log('💾 Avis sauvegardés.');
  } catch (err) {
    console.error('❌ Impossible de sauvegarder avis.json:', err);
  }
}

const soumissionsEnCours = new Map();
let sessions = {};

// ====== INITIALISATION DU BOT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: ['CHANNEL']
});

// Logs Discord pour debug
client.on('error', (err) => console.error('❌ Erreur client Discord:', err));
client.on('warn', (warn) => console.warn('⚠️ Warning Discord:', warn));
client.on('debug', (info) => console.log('🐛 Debug Discord:', info));

// ====== COMMANDES SLASH ======
const commands = [
  { name: 'soumettre', description: 'Soumettre un avis Google' },
  { name: 'mesavis', description: 'Voir vos avis soumis' },
  { name: 'aide', description: 'Afficher l’aide du bot' },
];

// Synchronisation commandes
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
  try {
    console.log('🔄 Synchronisation des commandes slash...');
    const appData = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(Routes.applicationCommands(appData.id), { body: commands });
    console.log('✅ Commandes slash synchronisées.');
  } catch (err) {
    console.error('❌ Erreur de synchro:', err);
  }
})();

// ====== BOT PRÊT ======
client.once('ready', () => {
  console.log(`🤖 Bot connecté : ${client.user.tag}`);
});

// ====== INTERACTIONS SLASH ======
client.on('interactionCreate', async (interaction) => {
  console.log(`📩 Interaction reçue : ${interaction.commandName} de ${interaction.user.tag}`);
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  const { commandName, user } = interaction;

  try {
    if (commandName === 'soumettre') {
      await interaction.reply({ content: '📩 DM envoyé pour continuer.', ephemeral: true });
      const dm = await user.createDM();
      soumissionsEnCours.set(user.id, { etape: 'lien_avis', data: {} });
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('📝 Soumission d\'avis (1/3)')
        .setDescription('Envoie ton lien Google (http/https).');
      await dm.send({ embeds: [embed] });
      console.log(`➡️ DM envoyé à ${user.tag}`);
    }

    if (commandName === 'mesavis') {
      const mesAvis = avis.filter(a => a.userId === user.id);
      if (mesAvis.length === 0) return interaction.reply({ content: 'Aucun avis trouvé.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('📊 Vos avis')
        .setDescription(`Vous avez ${mesAvis.length} avis :`);
      mesAvis.forEach(a => {
        const emoji = a.statut === 'paye' ? '✅' : a.statut === 'refuse' ? '❌' : '⏳';
        embed.addFields({ name: `${emoji} Avis #${a.id}`, value: `Statut: **${a.statut}**\nLien: ${a.lienAvis}` });
      });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'aide') {
      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('📖 Commandes')
        .addFields(
          { name: '/soumettre', value: 'Soumettre un avis (DM)' },
          { name: '/mesavis', value: 'Voir vos avis' },
          { name: '/aide', value: 'Aide' },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error('❌ Erreur interactionCreate:', err);
  }
});

// ====== MESSAGES PRIVÉS ======
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.channel.type !== ChannelType.DM) return;
  const userId = message.author.id;
  if (!soumissionsEnCours.has(userId)) return;
  const soumission = soumissionsEnCours.get(userId);

  console.log(`✉️ DM reçu de ${message.author.tag} à l'étape ${soumission.etape}`);

  try {
    switch (soumission.etape) {
      case 'lien_avis': {
        const lien = message.content.trim();
        if (!/^https?:\/\/[^\s]+$/i.test(lien)) return message.reply('❌ Lien invalide.');
        soumission.data.lienAvis = lien;
        soumission.etape = 'moyen_paiement';
        await message.reply('💰 Étape 2/3: 1=PayPal, 2=LTC');
        break;
      }
      case 'moyen_paiement': {
        const choix = message.content.trim();
        if (choix === '1') soumission.data.moyenPaiement = 'PayPal';
        else if (choix === '2') soumission.data.moyenPaiement = 'Litecoin (LTC)';
        else return message.reply('❌ Réponds 1 ou 2.');
        soumission.etape = 'adresse_paiement';
        await message.reply(`📩 Étape 3/3: Envoie ton adresse ${soumission.data.moyenPaiement}`);
        break;
      }
      case 'adresse_paiement': {
        const adresse = message.content.trim();
        if (adresse.length < 5) return message.reply('❌ Adresse invalide.');
        const deja = avis.find(a => a.userId === userId && a.lienAvis === soumission.data.lienAvis);
        if (deja) return message.reply('⚠️ Lien déjà soumis.');
        const nouvelAvis = { 
          id: avisIdCounter++, 
          userId, 
          username: message.author.username, 
          lienAvis: soumission.data.lienAvis, 
          moyenPaiement: soumission.data.moyenPaiement, 
          adressePaiement: adresse, 
          montant: 0.5, 
          statut: 'en_attente', 
          date: new Date().toISOString() 
        };
        avis.push(nouvelAvis);
        saveAvis();
        soumissionsEnCours.delete(userId);
        await message.reply('✅ Avis soumis !');
        break;
      }
    }
  } catch (err) {
    console.error('❌ Erreur messageCreate:', err);
  }
});

// ====== LOGIN PANEL ======
app.post('/login', (req, res) => {
  const { password } = req.body;
  let role = null;
  if (password === ADMIN_PASSWORD) role = 'admin';
  else if (password === FOURNISSEUR_PASSWORD) role = 'fournisseur';
  if (!role) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const token = Math.random().toString(36).substr(2);
  sessions[token] = role;
  res.json({ success: true, token, role, ltcAddress: role === 'fournisseur' ? LTC_ADDRESS : null });
});

function authMiddleware(req, res, next) {
  const token = req.headers['x-panel-token'] || req.query.token;
  if (!token || !sessions[token]) return res.status(401).send('Non autorisé');
  req.userRole = sessions[token];
  next();
}

// ====== API PANEL ======
app.get('/api/panel/avis', authMiddleware, (req, res) => {
  const role = req.userRole;
  if (role === 'admin') return res.json(avis);

  if (role === 'fournisseur') {
    const filteredAvis = avis.map(a => ({
      id: a.id,
      username: a.username,
      statut: a.statut,
      lienAvis: a.lienAvis,
      montant: a.montant,
      date: a.date,
      moyenPaiement: a.moyenPaiement
    }));
    return res.json({ avis: filteredAvis, ltcAddress: LTC_ADDRESS });
  }
});

app.post('/api/panel/payer/:id', authMiddleware, async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès interdit' });
  const avisItem = avis.find(a => a.id == req.params.id);
  if (!avisItem) return res.status(404).json({ error: 'Avis introuvable' });
  avisItem.statut = 'paye';
  saveAvis();
  try {
    const user = await client.users.fetch(avisItem.userId);
    if (user) {
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Paiement confirmé !')
        .setDescription(`Ton avis #${avisItem.id} a été validé et payé.`)
        .addFields({ name: '💰 Montant', value: `${avisItem.montant}€` }, { name: '🔗 Lien', value: avisItem.lienAvis })
        .setTimestamp();
      await user.send({ embeds: [embed] });
    }
  } catch (err) {
    console.warn(`⚠️ Impossible d’envoyer le DM à ${avisItem.username}:`, err.message);
  }
  res.json({ success: true });
});

app.post('/api/panel/refuser/:id', authMiddleware, async (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Accès interdit' });
  const { justification } = req.body;
  const avisItem = avis.find(a => a.id == req.params.id);
  if (!avisItem) return res.status(404).json({ error: 'Avis introuvable' });
  avisItem.statut = 'refuse';
  avisItem.justification = justification || 'Non précisée';
  saveAvis();
  try {
    const user = await client.users.fetch(avisItem.userId);
    if (user) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Avis refusé')
        .setDescription(`Ton avis #${avisItem.id} a été refusé.`)
        .addFields({ name: '🔗 Lien', value: avisItem.lienAvis }, { name: '📝 Raison', value: avisItem.justification })
        .setTimestamp();
      await user.send({ embeds: [embed] });
    }
  } catch (err) {
    console.warn(`⚠️ Impossible d’envoyer le DM à ${avisItem.username}:`, err.message);
  }
  res.json({ success: true });
});

app.post('/api/fournisseur/envoyer/:id', authMiddleware, async (req, res) => {
  if(req.userRole !== 'fournisseur') return res.status(403).json({ error: 'Accès interdit' });
  const avisItem = avis.find(a => a.id == req.params.id);
  if(!avisItem) return res.status(404).json({ error: 'Avis introuvable' });
  const { messageDiscord } = req.body;
  try {
    const admin = await client.users.fetch(ADMIN_DISCORD_ID);
    await admin.send(`💸 Le fournisseur a payé l'avis #${avisItem.id}.\nMessage: ${messageDiscord}`);
    avisItem.statut = 'paye';
    saveAvis();
    res.json({ success: true });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Impossible d’envoyer le message Discord' });
  }
});

// ====== LANCER SERVEUR WEB ======
app.listen(PORT, () => console.log(`🚀 Serveur web lancé sur http://localhost:${PORT}`));

// ====== LOGIN BOT ======
client.login(BOT_TOKEN)
  .then(() => console.log('🔑 Tentative de connexion du bot...'))
  .catch(err => console.error('❌ Impossible de se connecter au bot:', err));


