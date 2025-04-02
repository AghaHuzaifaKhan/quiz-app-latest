const formidable = require('formidable');
const Course = require("./../models/course.model");
const PDFExtract = require('pdf.js-extract').PDFExtract;
const pdfgen = require("pdf-to-office");
const fs = require('fs');
const { HfInference } = require('@huggingface/inference');
const langdetect = require('langdetect');

// Initialize Hugging Face with API token
const hf = new HfInference(process.env.HUGGING_FACE_TOKEN);

// Helper function to generate better fallback questions
function generateFallbackQuestion(text, language) {
    const cleanText = prepareText(text);
    const keyTerms = extractKeyTerms(cleanText);
    
    // Generate contextual options based on key terms
    function generateOptions(mainTopic, terms) {
        const options = [];
        // Use the main topic as correct answer
        options.push(mainTopic);
        
        // Generate plausible but incorrect options using key terms
        if (terms.length >= 3) {
            options.push(`The relationship between ${terms[0]} and ${terms[1]}`);
            options.push(`The impact of ${terms[2]} on ${terms[0]}`);
            options.push(`The development of ${terms[1]} through ${terms[2]}`);
        } else {
            // Fallback if not enough terms
            options.push(`A different aspect of ${mainTopic}`);
            options.push(`Historical development of ${mainTopic}`);
            options.push(`Future implications of ${mainTopic}`);
        }
        return options;
    }

    // Extract main topic from first sentence
    const mainTopic = text.split('.')[0].trim();
    const options = generateOptions(mainTopic, keyTerms);

    const templates = {
        'en': {
            questions: [
                `What is the primary focus of the text regarding ${keyTerms[0] || 'this topic'}?`,
                `Which aspect of ${keyTerms[0] || 'the subject'} does the text mainly discuss?`,
                `What is the main argument presented about ${keyTerms[0] || 'this topic'}?`
            ],
            options: options
        },
        'es': {
            questions: [
                `¿Cuál es el enfoque principal del texto sobre ${keyTerms[0] || 'este tema'}?`,
                `¿Qué aspecto de ${keyTerms[0] || 'el tema'} discute principalmente el texto?`,
                `¿Cuál es el argumento principal presentado sobre ${keyTerms[0] || 'este tema'}?`
            ],
            options: options
        },
        'fr': {
            questions: [
                `Quel est le point principal du texte concernant ${keyTerms[0] || 'ce sujet'}?`,
                `Quel aspect de ${keyTerms[0] || 'le sujet'} le texte discute-t-il principalement?`,
                `Quel est l'argument principal présenté sur ${keyTerms[0] || 'ce sujet'}?`
            ],
            options: options
        }
    };

    const langTemplate = templates[language] || templates['en'];
    const randomQuestion = langTemplate.questions[Math.floor(Math.random() * langTemplate.questions.length)];

    return {
        question: randomQuestion,
        options: langTemplate.options,
        answer: langTemplate.options[0] // First option is always correct in our generation
    };
}

// Helper function to chunk text into smaller pieces
function chunkText(text, maxLength = 250) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const chunks = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length <= maxLength) {
            currentChunk += sentence;
        } else {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

// Helper function to clean and prepare text
function prepareText(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

// Helper function to extract key terms from text
function extractKeyTerms(text) {
    // Remove common words and get key terms
    const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
    const words = text.toLowerCase().split(/\W+/);
    return words
        .filter(word => word.length > 3 && !commonWords.includes(word))
        .slice(0, 5);
}

// Helper function to format the AI prompt based on language
function getPrompt(text, language) {
    const cleanText = prepareText(text);
    const keyTerms = extractKeyTerms(cleanText);
    
    const questionTypes = {
        'en': [
            {
                template: "Based on the text, what is the main purpose of",
                context: `Consider the relationship between ${keyTerms.slice(0, 2).join(' and ')}`
            },
            {
                template: "Which of the following best explains how",
                context: `Focus on the key concepts: ${keyTerms.join(', ')}`
            },
            {
                template: "What is the primary relationship between",
                context: `Analyze the connection between different elements`
            },
            {
                template: "How does the text characterize",
                context: `Consider the description and analysis provided`
            }
        ],
        'es': [
            {
                template: "Según el texto, ¿cuál es el propósito principal de",
                context: `Considera la relación entre ${keyTerms.slice(0, 2).join(' y ')}`
            },
            {
                template: "¿Cuál de las siguientes opciones explica mejor cómo",
                context: `Enfócate en los conceptos clave: ${keyTerms.join(', ')}`
            }
        ],
        'fr': [
            {
                template: "D'après le texte, quel est l'objectif principal de",
                context: `Considérez la relation entre ${keyTerms.slice(0, 2).join(' et ')}`
            },
            {
                template: "Laquelle des options suivantes explique le mieux comment",
                context: `Concentrez-vous sur les concepts clés: ${keyTerms.join(', ')}`
            }
        ]
    };

    const templates = questionTypes[language] || questionTypes['en'];
    const selectedTemplate = templates[Math.floor(Math.random() * templates.length)];
    
    const basePrompt = {
        'en': `Generate a multiple choice question about this text.

Text: "${cleanText}"

CONTEXT: ${selectedTemplate.context}
QUESTION TYPE: ${selectedTemplate.template}

IMPORTANT: Follow this EXACT format:
[Your complete question]<$$$>[First option - most relevant]<$$$>[Second option - partially relevant]<$$$>[Third option - related but incorrect]<$$$>[Fourth option - clearly incorrect]<$$$>$ANSWER$[Correct option]

Requirements:
1. Question should be specific and based on the text content
2. Options must be distinct and realistic
3. Make options similar in length and style
4. Correct answer must be clearly supported by the text
5. Avoid obvious incorrect options`,

        'es': `Genera una pregunta de opción múltiple sobre este texto.

Texto: "${cleanText}"

CONTEXTO: ${selectedTemplate.context}
TIPO DE PREGUNTA: ${selectedTemplate.template}

IMPORTANTE: Sigue este formato EXACTO:
[Tu pregunta completa]<$$$>[Primera opción - más relevante]<$$$>[Segunda opción - parcialmente relevante]<$$$>[Tercera opción - relacionada pero incorrecta]<$$$>[Cuarta opción - claramente incorrecta]<$$$>$ANSWER$[Opción correcta]`,

        'fr': `Créez une question à choix multiples à partir de ce texte.

Texte: "${cleanText}"

CONTEXTE: ${selectedTemplate.context}
TYPE DE QUESTION: ${selectedTemplate.template}

IMPORTANT: Suivez ce format EXACT:
[Votre question complète]<$$$>[Première option - plus pertinente]<$$$>[Deuxième option - partiellement pertinente]<$$$>[Troisième option - liée mais incorrecte]<$$$>[Quatrième option - clairement incorrecte]<$$$>$ANSWER$[Option correcte]`
    };

    return basePrompt[language] || basePrompt['en'];
}

exports.makeProAction = async (req, res) => {
    try {
        // Create uploads directory if it doesn't exist
        const uploadDir = __dirname + '/../uploads';
        if (!fs.existsSync(uploadDir)){
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const form = new formidable.IncomingForm({ 
            uploadDir: uploadDir, 
            keepExtensions: true,
            multiples: false,
            maxFileSize: 50 * 1024 * 1024
        });
        
        form.parse(req, async (err, fields, files) => {
            if (err) {
                return res.status(400).json({
                    status: "error",
                    message: "Error parsing form data"
                });
            }

            if (!files.problemPdf) {
                return res.status(400).json({
                    status: "error",
                    message: "No PDF file uploaded"
                });
            }

            const filePath = files.problemPdf.filepath || files.problemPdf[0].filepath;

            try {
                console.log("Processing file:", filePath);
                const type = fields.type[0];
                const count = Number(fields.count[0]);
                const language = fields.language[0] || 'en';

                const pdf = new PDFExtract(pdfgen);
                const data = await pdf.extractBuffer(fs.readFileSync(filePath), {});
                let textContent = '';
                data.pages.forEach(page => {
                    page.content.forEach(item => {
                        if (item.str) {
                            textContent += item.str + ' ';
                        }
                    });
                });

                // Detect language if auto is selected
                let detectedLanguage = language;
                if (language === 'auto') {
                    try {
                        const detection = langdetect.detect(textContent);
                        detectedLanguage = detection[0].lang;
                    } catch (error) {
                        console.log("Language detection failed, using English");
                        detectedLanguage = 'en';
                    }
                }

                // Split text into chunks for processing
                const chunks = chunkText(textContent);
                const questions = [];
                let retryCount = 0;
                const maxRetries = 3;

                // Generate questions for each chunk until we reach the desired count
                for (let i = 0; i < chunks.length && questions.length < count; i++) {
                    try {
                        const prompt = getPrompt(chunks[i], detectedLanguage);
                        try {
                            console.log("Sending request to model with prompt:", prompt);
                            const response = await hf.textGeneration({
                                model: 'google/flan-t5-base',  // Using base model for better quality
                                inputs: prompt,
                                parameters: {
                                    max_new_tokens: 300,     // Increased for more detailed responses
                                    temperature: 0.75,       // Balanced between creativity and accuracy
                                    top_k: 50,              // Increased for more vocabulary options
                                    top_p: 0.95,            // Increased for better quality
                                    do_sample: true,
                                    repetition_penalty: 1.2,
                                    length_penalty: 1.0,     // Balanced length control
                                    num_return_sequences: 1
                                }
                            });

                            if (!response || !response.generated_text) {
                                console.error("No response from model");
                                throw new Error("No response from model");
                            }

                            const generatedText = response.generated_text.trim();
                            console.log("Generated text:", generatedText);
                            
                            // Validate question format
                            if (generatedText.includes('<$$$>') && generatedText.includes('$ANSWER$')) {
                                const parts = generatedText.split('<$$$>');
                                if (parts.length >= 6) {
                                    questions.push(generatedText);
                                    retryCount = 0; // Reset retry count on success
                                    console.log("Successfully generated question:", parts[0]);
                                } else {
                                    console.log("Invalid question format - not enough parts");
                                    throw new Error("Invalid question format");
                                }
                            } else {
                                console.log("Invalid question format - missing delimiters");
                                throw new Error("Invalid question format");
                            }
                        } catch (error) {
                            console.error("Error in question generation:", error.message);
                            // If we fail to generate a question, use fallback
                            const fallbackQuestion = generateFallbackQuestion(chunks[i], detectedLanguage);
                            const formattedFallback = `${fallbackQuestion.question}<$$$>${fallbackQuestion.options.join('<$$$>')}<$$$>$ANSWER$${fallbackQuestion.answer}`;
                            questions.push(formattedFallback);
                            console.log("Using fallback question");
                        }
                    } catch (error) {
                        console.error("Error generating question:", error.message);
                        retryCount++;
                        if (retryCount >= maxRetries) {
                            i++; // Move to next chunk after max retries
                            retryCount = 0;
                        }
                        continue;
                    }
                }

                // Process and save generated questions
                let savedCount = 0;
                for (const questionText of questions) {
                    const proList = questionText.split('<$$$>');
                    if (proList.length >= 6) {
                        const courseData = new Course({
                            problem: proList[0],
                            items: proList.slice(1, 5),
                            answer: proList[5].replace('$ANSWER$', ''),
                            type: type,
                            language: detectedLanguage,
                            user_id: req.user._id
                        });
                        await courseData.save();
                        savedCount++;
                    }
                }

                // Clean up: Delete the temporary PDF file
                fs.unlinkSync(filePath);

                res.status(200).json({
                    status: "success",
                    language: detectedLanguage,
                    questionsGenerated: savedCount,
                    message: savedCount > 0 ? `Successfully generated ${savedCount} questions` : "Could not generate questions, please try again"
                });
            } catch (error) {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                throw error;
            }
        });
    } catch (e) {
        res.status(400).json({
            status: "error",
            message: e.message
        });
    }
}

exports.deleteAction = async (req, res) => {
    try {
        const { _id } = req.body;
        await Course.deleteOne({ _id });
        res.status(200).json({
            status: "success"
        })
    } catch (e) {
        res.status(400).json({
            status: "error",
            message: e.message
        })
    }
}

exports.readAction = async (req, res) => {
    try {
        const { type, language } = req.body;
        const query = { type };
        if (language) {
            query.language = language;
        }
        const problems = await Course.find(query);
        res.status(200).json({
            status: "success",
            problems: problems
        })
    } catch (e) {
        res.status(400).json({
            status: "error",
            message: e.message
        })
    }
}

exports.readMineAction = async (req, res) => {
    try {
        const { type, language } = req.body;
        const user_id = req.user._id;
        const query = { type, user_id };
        if (language) {
            query.language = language;
        }
        const problems = await Course.find(query);
        res.status(200).json({
            status: "success",
            problems: problems
        })
    } catch (e) {
        res.status(400).json({
            status: "error",
            message: e.message
        })
    }
}