require('dotenv').config();
const path = require('path');
const MSSQL = require('./db');

async function main() {
  const client = new MSSQL({
    server: process.env.SQL_SERVER,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 1433,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: process.env.DB_ENCRYPT ? process.env.DB_ENCRYPT.toLowerCase() === 'true' : true,
      trustServerCertificate: process.env.DB_TRUST_CERT ? process.env.DB_TRUST_CERT.toLowerCase() === 'true' : false
    }
  });

  const definitionsPath = process.argv[2] || path.join(__dirname, 'reports.json');
  const outputPath = process.argv[3] || path.join(__dirname, client.buildWorkbookFileName());

  try {
    const resultPath = await client.runReports(definitionsPath, outputPath);
    console.log(`Workbook created: ${resultPath}`);
  } catch (error) {
    console.error('Report generation failed:', error.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
