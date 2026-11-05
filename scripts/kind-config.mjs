// Залишаю сумісний імпорт для коду, який ще використовує назву kindConfigWithoutNotes
// Справжня реалізація одна й лежить у deployment-config.mjs

// Зберігаю попередню назву функції для сумісності; усі пояснення тепер прибирає спільний helper
export { deploymentConfigWithoutNotes as kindConfigWithoutNotes } from './deployment-config.mjs';
