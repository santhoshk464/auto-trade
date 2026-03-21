// Simple script to call the fix-unlinked-signals API endpoint
const http = require('http');

// First, we need to get the JWT token
// You'll need to provide your email/password or use an existing cookie

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/signals/fix-unlinked',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // Add your auth cookie here if you have one
    // 'Cookie': 'at=your-jwt-token-here'
  },
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log('\nResponse Status:', res.statusCode);
    if (res.statusCode === 401) {
      console.log('\n⚠️  You need to be authenticated to use this endpoint.');
      console.log(
        'Please visit http://localhost:3000/dashboard in your browser,',
      );
      console.log('then run this command in the browser console:\n');
      console.log(
        'fetch("http://localhost:3001/signals/fix-unlinked", { method: "POST", credentials: "include" })',
      );
      console.log('  .then(r => r.json()).then(console.log)');
    } else {
      console.log('\nResponse:');
      try {
        const json = JSON.parse(data);
        console.log(JSON.stringify(json, null, 2));
      } catch (e) {
        console.log(data);
      }
    }
  });
});

req.on('error', (error) => {
  console.error('Error:', error.message);
  console.log(
    '\n⚠️  Make sure the API server is running on http://localhost:3001',
  );
});

req.end();
