require('dotenv').config();
const path = require('path');
const MSSQL = require('./db');

async function main() {
  const client = new MSSQL({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: true,
      trustServerCertificate: false
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
