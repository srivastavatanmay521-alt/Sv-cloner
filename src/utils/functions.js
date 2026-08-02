const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function handleRateLimit(promise, maxRetries = 3) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            return await promise;
        } catch (error) {
            if (error.code === 50001 || error.message?.includes('rate limit')) {
                retries++;
                const waitTime = Math.min(1000 * Math.pow(2, retries), 10000);
                console.log(`Rate limit hit, waiting ${waitTime}ms... (attempt ${retries}/${maxRetries})`);
                await delay(waitTime);
            } else {
                throw error;
            }
        }
    }
    throw new Error('Max retries exceeded for rate limit');
}

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const mimeType = res.headers['content-type'] || 'image/png';
                resolve(`data:${mimeType};base64,${base64}`);
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

module.exports = { delay, downloadImage, handleRateLimit };