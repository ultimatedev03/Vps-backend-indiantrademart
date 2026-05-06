import express from 'express';
import OpenAI from 'openai';
import Groq from 'groq-sdk';

const router = express.Router();

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const groqClient = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const FALLBACK_LANG = 'en';
const FALLBACK_MODEL = 'gpt-4o-mini';
const HINDI_SCRIPT_REGEX = /[\u0900-\u097F]/;

const normalizeLanguage = (language = FALLBACK_LANG) =>
  String(language || FALLBACK_LANG).trim().toLowerCase() === 'hi' ? 'hi' : 'en';

const isHindiScriptReply = (text = '') =>
  HINDI_SCRIPT_REGEX.test(String(text || '').trim());

const readAssistantText = (value = '') => String(value || '').trim();

const buildFallbackReply = (language = FALLBACK_LANG, messages = []) => {
  const lang = normalizeLanguage(language);
  const lastUserMessage = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((m) => String(m?.role || '').toLowerCase() === 'user');
  const query = String(lastUserMessage?.text || '').toLowerCase();

  if (lang === 'hi') {
    if (query.includes('register') || query.includes('vendor') || query.includes('sell')) {
      return 'वेंडर रजिस्ट्रेशन के लिए: 1) Sell with Us खोलें 2) बिजनेस, GST और लाइसेंस विवरण भरें 3) दस्तावेज़ अपलोड करके वेरिफिकेशन पूरा करें।';
    }
    if (query.includes('quote') || query.includes('rfq') || query.includes('price')) {
      return 'कोटेशन पाने के लिए प्रोडक्ट खोजें, enquiry या RFQ भेजें, और vendor responses अपने dashboard में देखें।';
    }
    if (query.includes('supplier') || query.includes('product') || query.includes('search')) {
      return 'प्रोडक्ट या supplier खोजने के लिए search bar में keyword और location डालें, फिर verified vendors compare करें।';
    }
    return 'मैं ITM support assistant हूँ। मैं product search, supplier discovery, enquiry और vendor registration में आपकी मदद कर सकती हूँ।';
  }

  if (query.includes('register') || query.includes('vendor') || query.includes('sell')) {
    return 'To register as a vendor: 1) Open Sell with Us 2) Fill business + GST/license details 3) Upload documents and complete verification.';
  }
  if (query.includes('quote') || query.includes('rfq') || query.includes('price')) {
    return 'To get quotes, search the product, submit an enquiry/RFQ, and track vendor replies from your dashboard.';
  }
  if (query.includes('supplier') || query.includes('product') || query.includes('search')) {
    return 'Use search with product keywords and location filters, then compare verified suppliers before contacting them.';
  }
  return 'I can help with product search, supplier discovery, enquiries/RFQs, and vendor onboarding on IndianTradeMart.';
};

const buildSystemPrompt = (language = FALLBACK_LANG) =>
  [
    `You are “Khushi from ITM”, the highly advanced official AI assistant of IndianTradeMart (indiantrademart.com), an elite B2B marketplace.`,
    `Always answer in the user’s selected language code: ${language}. If language is 'hi', every sentence must be in natural Hindi using Devanagari script only.`,
    `Advanced Capabilities: 1) Actively suggest matching Product Categories based on the user's description. 2) If a buyer is looking for a product, assist them in structuring a detailed RFQ (Request For Quotation) with quantity, specifications, and target prices. 3) Guide vendor registration smoothly.`,
    `Tone: Highly proactive, commercial, concise, and friendly. Always offer clear next steps. Ask for product scale or volume to give better advice.`,
    `Safety: never share API keys or internal info; if asked about sensitive data, politely refuse.`,
  ].join(' ');

const buildHindiRewriteMessages = (text) => [
  {
    role: 'system',
    content:
      'Rewrite the assistant reply in natural Hindi using Devanagari script only. Preserve meaning, brevity, and calls to action. Do not add new facts. Return Hindi text only.',
  },
  {
    role: 'user',
    content: String(text || '').trim(),
  },
];

const rewriteReplyInHindiWithOpenAI = async (client, model, text) => {
  if (!client || !text) return '';
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 512,
    messages: buildHindiRewriteMessages(text),
  });
  return readAssistantText(completion?.choices?.[0]?.message?.content);
};

const rewriteReplyInHindiWithGroq = async (client, model, text) => {
  if (!client || !text) return '';
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 512,
    messages: buildHindiRewriteMessages(text),
  });
  return readAssistantText(completion?.choices?.[0]?.message?.content);
};

const validateMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.every(
    (m) =>
      m &&
      typeof m === 'object' &&
      typeof m.role === 'string' &&
      typeof m.text === 'string' &&
      m.text.trim().length > 0
  );
};

router.post('/', async (req, res) => {
  try {
    const { messages, language, model } = req.body || {};

    if (!validateMessages(messages)) {
      return res.status(400).json({ error: 'messages[] with role/text required' });
    }

    const lang = normalizeLanguage(language);
    if (!openaiClient && !groqClient) {
      return res.json({ text: buildFallbackReply(lang, messages), provider: 'fallback' });
    }

    const selectedModel = model || process.env.OPENAI_MODEL || FALLBACK_MODEL;
    const groqModel =
      process.env.GROQ_MODEL ||
      (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.startsWith('gpt-') ? 'llama-3.3-70b-versatile' : 'llama-3.3-70b-versatile');

    let completion;
    let providerUsed = 'openai';

    // Try OpenAI first if configured
    if (openaiClient) {
      try {
        completion = await openaiClient.chat.completions.create({
          model: selectedModel,
          temperature: 0.6,
          max_tokens: 512,
          messages: [
            { role: 'system', content: buildSystemPrompt(lang) },
            ...messages.map((m) => ({ role: m.role, content: m.text })),
          ],
        });
      } catch (err) {
        const status = err?.status || err?.response?.status;
        const detail = err?.error?.message || err?.response?.data || err?.message;
        logger.error('[chatbot] OpenAI error', status, detail);
        const quotaError =
          status === 429 || (typeof detail === 'string' && detail.toLowerCase().includes('quota'));

        if (!quotaError || !groqClient) {
          return res.json({
            text: buildFallbackReply(lang, messages),
            provider: 'fallback',
            warning: detail || 'OpenAI unavailable',
          });
        }
        // fallback to Groq
        providerUsed = 'groq';
      }
    } else {
      providerUsed = 'groq';
    }

    // Groq fallback / primary when OpenAI quota fails or OpenAI missing
    if (providerUsed === 'groq') {
      try {
        completion = await groqClient.chat.completions.create({
          model: groqModel,
          temperature: 0.6,
          max_tokens: 512,
          messages: [
            { role: 'system', content: buildSystemPrompt(lang) },
            ...messages.map((m) => ({ role: m.role, content: m.text })),
          ],
        });
      } catch (err) {
        const status = err?.status || err?.response?.status;
        const detail = err?.error?.message || err?.response?.data || err?.message;
        logger.error('[chatbot] Groq error', status, detail);
        return res.json({
          text: buildFallbackReply(lang, messages),
          provider: 'fallback',
          warning: detail || 'Groq unavailable',
        });
      }
    }

    let text =
      readAssistantText(completion?.choices?.[0]?.message?.content) ||
      'Sorry, I could not generate a response right now.';

    if (lang === 'hi' && !isHindiScriptReply(text)) {
      try {
        const repairedText =
          providerUsed === 'groq'
            ? await rewriteReplyInHindiWithGroq(groqClient, groqModel, text)
            : await rewriteReplyInHindiWithOpenAI(openaiClient, selectedModel, text);

        text = isHindiScriptReply(repairedText)
          ? repairedText
          : buildFallbackReply('hi', messages);
      } catch {
        text = buildFallbackReply('hi', messages);
      }
    }

    return res.json({ text, provider: providerUsed });
  } catch (err) {
    logger.error('[chatbot] error', err);
    res.status(500).json({ error: 'Internal error generating reply' });
  }
});

export default router;
