import dns from 'dns';
import fetch from 'node-fetch';

function checkDns() {
  console.log('--- DNS Lookup ---');
  dns.resolve4('gurupadukam.com', (err, addresses) => {
    if (err) {
      console.error('DNS Resolve Error:', err.message);
    } else {
      console.log('Resolves to IPs:', addresses);
    }
  });

  dns.resolveNs('gurupadukam.com', (err, addresses) => {
    if (err) {
      console.error('NS Resolve Error:', err.message);
    } else {
      console.log('Nameservers:', addresses);
    }
  });
}

async function checkHttp() {
  console.log('\n--- HTTP Fetch ---');
  try {
    const res = await fetch('https://gurupadukam.com', { timeout: 8000 });
    console.log('Status:', res.status);
    console.log('Headers:', res.headers.raw());
  } catch (err) {
    console.error('HTTP Error:', err.message);
  }
}

checkDns();
setTimeout(checkHttp, 2000);
