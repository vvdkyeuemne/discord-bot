import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

console.log('Key loaded?', !!process.env.GEMINI_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const res = await model.generateContent('Nói "hello" bằng 1 từ.');
    console.log('OK =>', res.response.text?.() || res.response.text);
  } catch (e) {
    console.error('FAILED =>', e?.status, e?.code, e?.message, e?.response?.data);
  }
}
run();
