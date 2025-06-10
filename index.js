import dotenv from 'dotenv';
import express, { json } from 'express';
import cors from 'cors';
import { Mistral } from "@mistralai/mistralai";
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const APP_API_KEY = process.env.APP_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const BUCKET_DIR = process.env.CC_FS_BUCKET || '/dataset/bills';
const APP_HOME = process.env.APP_HOME || '/home/clevercloud/app';
const FULL_UPLOAD_PATH = path.join(APP_HOME, BUCKET_DIR);

const client = new Mistral({
    apiKey: MISTRAL_API_KEY
});

app.use(cors());
app.use(json({limit: '50mb'})); // Increase the limit to 50mb

app.use((req, res, next) => {
    console.log(`Request received: ${req.method} ${req.url}`);
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== APP_API_KEY) {
        console.log(`Invalid API key: ${apiKey}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    console.log(`Valid API key: ${apiKey}`);
    next();
});

app.post('/api/ticket-mistral-ocr', async (req, res) => {
    console.log('Received request on /api/ticket-mistral-ocr');
    try {
        const { base64_image } = req.body;
        if (!base64_image) {
            console.log('Missing base64_image in request body');
            return res.status(400).json({ error: 'Scan manquant. Veuillez scanner un document avant d\'en extraire des informations.' });
        }
        console.log('base64_image received, preparing to send to Mistral API');

        const mistralBody = {
            model: "mistral-small-latest",
            messages: [
                {
                    role: "system",
                    content: [
                        {
                            type: "text",
                            text: "Extraies la listes des articles et leur prix unitaire depuis des scan de ticket de caisse. Si tu vois deux fois le même article sur une même ligne avec un prix total et non un prix unitaire, je veux que tu les sépares en deux lignes. Je veux que tu me renvoies un JSON avec une liste d'objets contenant le nom de l'article et son prix unitaire. Le format du JSON : {'articles': [{'nomArticle': nom_article, 'prixUnitaire': prix_unitaire}]}. Si l'image est floue, illisible ou que ce n'est pas un ticket de caisse, je veux que tu me renvoies l'objet JSON suivant : { 'error': 'cannot_read' }. La réponse doit être un objet JSON et rien d'autre. Sans texte réalable, sans formatage, sans retour à la ligne, sans retour chariot de type '\\n' juste le JSON brut sans rien d'autre.",
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Extraies les information de ce scan de ticket de caisses et veille bien à respecter le format JSON demandé. Si l'image est floue, illisible ou que ce n'est pas un ticket de caisse, renvoie l'objet JSON suivant : { 'error': 'cannot_read' }.",
                        },
                        {
                            type: "image_url",
                            imageUrl: "data:image/jpeg;base64," + base64_image,
                        },
                    ],
                },
            ],
            responseFormat: {type: 'json_object'},
        };

        const mistralResponse = await client.chat.complete(mistralBody);
        console.log('Mistral API response received');

        var clientResult = JSON.parse(mistralResponse.choices[0].message.content);
        if (clientResult.error === 'cannot_read') {
            console.log('Mistral API returned cannot_read error');
            return res.status(400).json({ error: 'Le scan est flou, illisible ou n\'a pas été identifié comme un ticket de caisse. Veuillez essayer avec un autre scan.' });
        }

        // *** SAUVEGARDE DE L'IMAGE ***
        if (!fs.existsSync(FULL_UPLOAD_PATH)) {
            fs.mkdirSync(FULL_UPLOAD_PATH, { recursive: true });
        }
        
        // Génère un nom de fichier unique
        const filename = `${uuidv4()}_${Date.now()}.jpg`;
        // Decode le base64 en buffer
        const imgBuffer = Buffer.from("data:image/jpeg;base64," + base64_image, 'base64');
        // Ecrit dans le FS Bucket
        fs.writeFile(
            path.join(FULL_UPLOAD_PATH, filename),
            imgBuffer,
            (err) => {
                if (err) {
                    console.error('Erreur lors de la sauvegarde de l\'image dans le FS Bucket:', err);
                } else {
                    console.log(`Image sauvegardée dans le FS Bucket : ${path.join(FULL_UPLOAD_PATH, filename)}`);
                    // vérifier si le fichier a été sauvegardé
                    if (!fs.existsSync(path.join(FULL_UPLOAD_PATH, filename))) {
                        console.error('Le fichier n\'a pas été sauvegardé correctement dans le FS Bucket');
                        return res.status(500).json({ error: 'Erreur lors de la sauvegarde de l\'image. Veuillez réessayer.' });
                    }
                }
            }
        );

        res.json(clientResult);
        console.log('Response sent to client');
    } catch (err) {
        console.error('Error processing request:', err);
        res.status(err.response?.status || 500).json({ error: err.message, details: err.response?.data });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
