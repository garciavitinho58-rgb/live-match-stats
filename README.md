# Live Match Stats V2

Servidor Node.js + painel web. O navegador fala apenas com este servidor; o servidor consulta os endpoints públicos do SofaScore.

## Rodar localmente
Requer Node.js 18+:
```bash
npm start
```
Abra http://localhost:3000

## Deploy
### Render
- New Web Service
- conecte este projeto
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: Node

### Railway
- New Project -> Deploy from GitHub
- Start Command: `npm start`

### Vercel
Este projeto usa um servidor Node persistente e foi pensado primeiro para Render/Railway. Para Vercel, adapte o servidor para funções serverless.

## Observação
A disponibilidade dos endpoints depende do SofaScore e de eventuais mudanças/limites do serviço. O projeto não contorna autenticação ou mecanismos de segurança.
