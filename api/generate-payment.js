// Importa o Firebase Admin para ler o banco de dados de forma segura
import admin from 'firebase-admin';
// Importa o CORS para permitir que seu site (Firebase) chame essa API (Vercel)
import Cors from 'cors';

// Inicializa o CORS
const cors = Cors({
  origin: 'https://seguidores-2a9d5.web.app', // <-- MUITO IMPORTANTE: Permite que seu site Firebase chame essa API
  methods: ['POST', 'OPTIONS'],
});

// ----------------------------------------------------------------
// PASSO 1: CONFIGURAÇÃO DO FIREBASE ADMIN
// ----------------------------------------------------------------
// Você precisa de uma "Chave de Conta de Serviço" do Firebase
// Siga as instruções no final desta resposta para obter a sua.
// Armazene-a como uma Variável de Ambiente na Vercel.
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('Erro ao ler a chave de conta de serviço. Verifique a variável de ambiente GOOGLE_SERVICE_ACCOUNT_JSON.');
}

// Inicializa o app Firebase Admin (só uma vez)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    console.error('Falha ao inicializar Firebase Admin:', e);
  }
}

const db = admin.firestore();

// ----------------------------------------------------------------
// FUNÇÃO AUXILIAR PARA O CORS
// ----------------------------------------------------------------
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

// ----------------------------------------------------------------
// A FUNÇÃO PRINCIPAL DA API
// ----------------------------------------------------------------
export default async function handler(request, response) {
  // Executa o middleware do CORS
  await runMiddleware(request, response, cors);

  // O Navegador envia um 'OPTIONS' primeiro (preflight). Respondemos OK.
  if (request.method === 'OPTIONS') {
    response.status(200).end();
    return;
  }

  // Só aceitamos POST
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).send('Método não permitido');
    return;
  }

  const { linkId, accountId, customerName } = request.body;

  if (!linkId || !accountId || !customerName) {
    return response.status(400).json({ success: false, error: 'Dados incompletos: linkId, accountId e customerName são obrigatórios.' });
  }

  try {
    // 1. Busca os dados do Link e da Conta (no backend, de forma segura)
    const linkRef = db.doc(`accounts/${accountId}/links/${linkId}`);
    const accountRef = db.doc(`accounts/${accountId}`);

    const [linkDoc, accountDoc] = await Promise.all([linkRef.get(), accountRef.get()]);

    if (!linkDoc.exists) {
      return response.status(404).json({ success: false, error: 'Link de pagamento não encontrado.' });
    }
    if (!accountDoc.exists) {
      return response.status(404).json({ success: false, error: 'Conta de configuração não encontrada.' });
    }

    const linkData = linkDoc.data();
    const accountData = accountDoc.data();
    const { activeGateway, gatewaySettings } = accountData;

    // Converte R$ 10,00 para 1000 (centavos)
    const amountInCents = Math.round(linkData.planValue * 100);

    // 2. Seleciona o Gateway e faz a chamada
    let pixData;

    switch (activeGateway) {
      case 'buckpay':
        const buckpayToken = gatewaySettings.buckpay_token;
        if (!buckpayToken) throw new Error("Token da BuckPay não configurado.");
        
        console.log('Chamando API BuckPay...');
        const buckpayResponse = await fetch("https://api.realtechdev.com.br/v1/transactions", {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${buckpayToken}`,
            'User-Agent': 'Buckpay API' // <-- O Header Fixo que você pediu!
          },
          body: JSON.stringify({
            external_id: linkId, 
            amount: amountInCents,
            payment_method: "pix"
          })
        });

        if (!buckpayResponse.ok) {
          const errorData = await buckpayResponse.json();
          console.error("Erro da API BuckPay:", errorData);
          throw new Error(errorData.message || 'Erro na API BuckPay');
        }

        const buckpayResult = await buckpayResponse.json();
        pixData = {
          pixCode: buckpayResult.data.pix.code,
          qrCodeImage: `data:image/png;base64,${buckpayResult.data.pix.qrcode_base64}`
        };
        break;

      case 'zeroonepay':
        const { zeroonepay_token, zeroonepay_offer_hash, zeroonepay_product_hash } = gatewaySettings;
        if (!zeroonepay_token || !zeroonepay_offer_hash || !zeroonepay_product_hash) {
          throw new Error("Credenciais da ZeroOnePay incompletas.");
        }
        
        console.log('Chamando API ZeroOnePay...');
        const apiUrl = new URL("https://api.zeroonepay.com.br/api/public/v1/checkout/pix");
        apiUrl.searchParams.append("api_token", zeroonepay_token);
        apiUrl.searchParams.append("offer_hash", zeroonepay_offer_hash);
        apiUrl.searchParams.append("product_hash", zeroonepay_product_hash);
        apiUrl.searchParams.append("email", "cliente@email.com"); // Email genérico
        apiUrl.searchParams.append("name", customerName);
        apiUrl.searchParams.append("amount", amountInCents);

        const zeroOneResponse = await fetch(apiUrl.toString(), { method: 'POST' });

        if (!zeroOneResponse.ok) {
          const errorData = await zeroOneResponse.json();
          console.error("Erro da API ZeroOnePay:", errorData);
          throw new Error(errorData.message || 'Erro na API ZeroOnePay');
        }

        const zeroOneResult = await zeroOneResponse.json();
        if (!zeroOneResult.success || !zeroOneResult.data) {
          throw new Error(zeroOneResult.message || 'Falha ao gerar PIX na ZeroOnePay.');
        }

        pixData = {
          pixCode: zeroOneResult.data.pix_code,
          qrCodeImage: zeroOneResult.data.qrcode_image // A ZeroOne já retorna a URL da imagem
        };
        break;

      // Adicione 'disrupty' e 'paradise' aqui se precisar
      // case 'disrupty':
      //   ...
      //   break;

      default:
        throw new Error(`Gateway '${activeGateway}' não suportado.`);
    }

    // 3. Envia a resposta de sucesso para o frontend
    console.log('Sucesso! Enviando dados do PIX para o frontend.');
    return response.status(200).json({ success: true, ...pixData });

  } catch (error) {
    console.error('Erro geral no handler da API:', error);
    return response.status(500).json({ success: false, error: error.message });
  }
}
