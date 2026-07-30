const sql = require('mssql');
const fs = require('fs/promises');
const path = require('path');
const { existsSync, readdirSync } = require('fs');

class MSSQL {
    constructor(config = {}) {
        this.config = config;
        this.pool = null;
    }

    async connect(connectionStringOrConfig = this.config) {
        try {
            const config = typeof connectionStringOrConfig === 'string'
                ? { connectionString: connectionStringOrConfig }
                : connectionStringOrConfig;

            const poolConfig = {
                ...config,
                options: {
                    encrypt: true,
                    trustServerCertificate: false,
                    ...(config.options || {})
                }
            };

            this.pool = await sql.connect(poolConfig);
            console.log('Connected to MSSQL');
            return this.pool;
        } catch (err) {
            console.error('Error connecting to MSSQL:', err);
            throw err;
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }
    }

    async query(queryText, params = {}) {
        if (!this.pool) {
            await this.connect();
        }

        try {
            const request = this.pool.request();
            Object.entries(params).forEach(([name, value]) => {
                request.input(name, value);
            });

            const result = await request.query(queryText);
            return result;
        } catch (err) {
            console.error('Error executing query:', err);
            throw err;
        }
    }

    async readFileAsync(file) {
        const raw = await fs.readFile(file, 'utf8');
        return JSON.parse(raw);
    }

    async buildDefinitionsFromFolder(folderPath) {
        if (!existsSync(folderPath)) {
            return [];
        }

        const entries = [];
        const files = readdirSync(folderPath)
            .filter((name) => name.toLowerCase().endsWith('.sql'))
            .sort();

        for (const name of files) {
            const fullPath = path.join(folderPath, name);
            const queryText = await fs.readFile(fullPath, 'utf8');
            const queries = this.extractQueriesFromScript(queryText);

            if (queries.length > 0) {
                entries.push({
                    name: name.replace(/\.sql$/i, ''),
                    query: queries.length === 1 ? queries[0] : queries,
                    sourceFile: fullPath
                });
            }
        }

        return entries;
    }

    extractQueriesFromScript(scriptText) {
        const cleaned = scriptText
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/--.*$/gm, ' ')
            .replace(/\r/g, '')
            .trim();

        const segments = cleaned
            .split(';')
            .map((value) => value.trim())
            .filter(Boolean);

        return segments.filter((segment) => {
            const normalized = segment.replace(/\b(?:USE|GO|DECLARE|SET)\b.*$/gim, '').trim();
            return /\bSELECT\b/i.test(normalized)
                && !/\b(?:EXEC|sp_executesql|xp_|sp_)\b/i.test(normalized)
                && !/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|MERGE|CREATE)\b/i.test(normalized)
                && !/\b(?:OPENROWSET|OPENQUERY)\b/i.test(normalized);
        });
    }

    validateQuery(queryText) {
        const queries = Array.isArray(queryText) ? queryText : [queryText];

        queries.forEach((entry) => {
            if (typeof entry !== 'string' || !entry.trim()) {
                throw new Error('Query must be a non-empty string.');
            }

            const normalized = entry
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                .replace(/--.*$/gm, ' ')
                .trim();

            const statements = normalized
                .split(';')
                .map((value) => value.trim())
                .filter(Boolean);

            if (statements.length > 1) {
                throw new Error('Only a single statement is allowed.');
            }

            if (/\b(?:EXEC|sp_executesql|xp_|sp_)\b/i.test(normalized)) {
                throw new Error('Dynamic SQL is not allowed.');
            }

            if (!/\bSELECT\b/i.test(normalized)) {
                throw new Error('Only SELECT statements are allowed.');
            }

            if (/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|MERGE|CREATE)\b/i.test(normalized)) {
                throw new Error('Only SELECT statements are allowed.');
            }

            if (/\b(?:OPENROWSET|OPENQUERY)\b/i.test(normalized)) {
                throw new Error('External rowset access is not allowed.');
            }
        });

        return true;
    }

    sanitizeWorksheetName(name) {
        const base = String(name || '').trim() || 'Sheet1';
        const sanitized = base
            .replace(/[\\/?*\[\]:]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/_+/g, '_')
            .trim();

        return sanitized.substring(0, 31);
    }

    buildWorkbookFileName(prefix = 'KPIReport') {
        const date = new Date();
        const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        return `${prefix}_${stamp}.xlsx`;
    }

    async generateWorkbook(reports, outputPath) {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();

        for (const report of reports) {
            const queries = Array.isArray(report.query)
                ? report.query
                : [report.query];

            if (!queries.length || !queries.some(Boolean)) {
                throw new Error(`Report ${report.name || 'Unnamed'} has no query.`);
            }

            this.validateQuery(queries);

            const worksheet = workbook.addWorksheet(this.sanitizeWorksheetName(report.name));
            const combinedRows = [];

            for (const queryText of queries) {
                const result = await this.query(queryText);
                const rows = result.recordset || [];
                combinedRows.push(...rows);
            }

            if (combinedRows.length > 0) {
                const headers = Object.keys(combinedRows[0]);
                worksheet.columns = headers.map((header) => ({
                    header,
                    key: header,
                    width: Math.max(header.length, 20)
                }));
                worksheet.addRows(combinedRows);
            } else {
                worksheet.columns = [{ header: 'No data', key: 'No data', width: 20 }];
                worksheet.addRow({ 'No data': 'No rows returned' });
            }

            worksheet.views = [{ state: 'frozen', ySplit: 1 }];
            worksheet.autoFilter = {
                from: 'A1',
                to: worksheet.lastColumn ? `${worksheet.lastColumn.letter}${worksheet.rowCount}` : 'A1'
            };
        }

        await workbook.xlsx.writeFile(outputPath);
        return outputPath;
    }

    async runReports(definitionsFile, outputFile) {
        let reports = [];
        let resolvedOutput = outputFile || path.join(path.dirname(definitionsFile), this.buildWorkbookFileName());

        if (definitionsFile && existsSync(definitionsFile)) {
            try {
                const definitions = await this.readFileAsync(definitionsFile);
                reports = Array.isArray(definitions) ? definitions : definitions.reports || [];
            } catch (error) {
                reports = [];
            }
        }

        if (!reports.length) {
            const folderPath = path.join(path.dirname(definitionsFile || __dirname), 'SQL');
            reports = await this.buildDefinitionsFromFolder(folderPath);
        }

        if (!reports.length) {
            throw new Error('No report definitions were found.');
        }

        await this.generateWorkbook(reports, resolvedOutput);
        return resolvedOutput;
    }
}

module.exports = MSSQL;

