/**
 * NOTIFICATIONS MODULE — Communication & Alerts
 *
 * Covers: in-app notifications, AI chatbot (OpenAI/Groq),
 * real-time alerts, notification preferences.
 */
import notificationRouter from '../../routes/notifications.js';
import chatbotRouter from '../../routes/chatbot.js';

export const notificationRoutes = Object.freeze([
  { path: '/api/notifications', router: notificationRouter },
  { path: '/api/chat', router: chatbotRouter },
]);
