// Тут описую відповідь /api/health, щоб сервер і клієнт однаково розуміли її поля
// Це тип даних, він сам не надсилає HTTP-запит і не виконує перевірку

// status ok означає, що HTTP-процес відповідає, а instanceId називає саме цей процес
// Готовність PostgreSQL і схеми перевіряю окремим /api/ready
export interface HealthResponse {
  status: "ok";
  instanceId: string;
}
