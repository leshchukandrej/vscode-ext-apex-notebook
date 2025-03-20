import * as vscode from 'vscode';
import * as sfdc_core from '@salesforce/core';
import * as sfdc from '@salesforce/apex-node';

// Local imports
import { NOTEBOOK_TYPE } from "../constants";
import * as CONSTANTS from '../constants';
import * as SalesforceHandler from '../handlers/salesforceHandler';
import { LogAnalyzerHandler, LogAnalysis } from '../handlers/logAnalyzerHandler';

/**
 * Controller for the Anonymous Apex Notebook
 * 
 * Handles execution of Apex code and SOQL queries in notebook cells,
 * manages the output of execution results, and provides utilities for
 * target org selection.
 */
export default class NotebookController {
    // Controller configuration
    private readonly controllerId = 'anon-apex-notebook-controller';
    private readonly notebookType = NOTEBOOK_TYPE;
    private readonly notebookLabel = 'Anon Apex Notebook';
    private readonly supportedLanguages = ['apex-anon', 'soql'];

    private readonly controller: vscode.NotebookController;

    /**
     * Creates a new instance of the notebook controller
     */
    constructor() {
        this.controller = vscode.notebooks.createNotebookController(
            this.controllerId,
            this.notebookType,
            this.notebookLabel
        );

        this.controller.supportedLanguages = this.supportedLanguages;
        this.controller.executeHandler = this.execute.bind(this);
    }

    /**
     * Main execution handler for notebook cells
     * Handles execution confirmation and dispatches cells for processing
     * 
     * @param cells Cells to execute
     * @param notebook Notebook document
     * @param controller Controller instance
     */
    private async execute(
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
        controller: vscode.NotebookController
    ): Promise<void> {
        const cellsToProcess = await this.determineCellsToExecute(cells);
        
        // Process each selected cell
        for (const cell of cellsToProcess) {
            await this.executeCell(cell);
        }
    }

    /**
     * Determines which cells to execute based on user preferences and confirmation
     * 
     * @param cells All selected cells
     * @returns Filtered list of cells to process
     */
    private async determineCellsToExecute(cells: vscode.NotebookCell[]): Promise<vscode.NotebookCell[]> {
        // If no Apex cells are selected, no confirmation needed
        if (!cells.some(cell => cell.document.languageId === 'apex-anon')) {
            return [...cells];
        }

        const confirmDialogPreference = vscode.workspace.getConfiguration().get(
            CONSTANTS.SETTING_KEY_CONFIRM_DIALOG_PREFERENCE
        );

        // Check if confirmation dialog should be shown
        const shouldShowConfirmation = 
            confirmDialogPreference === CONSTANTS.CONFIRM_DIALOG_OPTION_ALWAYS || 
            (confirmDialogPreference === CONSTANTS.CONFIRM_DIALOG_OPTION_ONLY_MULTIPLE && cells.length > 1);

        if (!shouldShowConfirmation) {
            return [...cells];
        }

        return await this.showExecutionConfirmation(cells);
    }

    /**
     * Shows confirmation dialog for execution and returns filtered cells
     * 
     * @param cells All selected cells
     * @returns Filtered list of cells based on user selection
     */
    private async showExecutionConfirmation(cells: vscode.NotebookCell[]): Promise<vscode.NotebookCell[]> {
        const apexCellCount = cells.filter(cell => cell.document.languageId === 'apex-anon').length;
        const soqlCellCount = cells.filter(cell => cell.document.languageId === 'soql').length;
        
        // Build options for the quick pick
        const options: string[] = [
            `Execute ${apexCellCount} Apex script(s) and ${soqlCellCount} SOQL queries`
        ];

        const hasApexCells = apexCellCount > 0;
        const hasSoqlCells = soqlCellCount > 0;

        // Add specialized options if we have both Apex and SOQL cells
        if (hasApexCells && hasSoqlCells) {
            options.push('Execute only Apex');
            options.push('Execute only SOQLs');
        }
        options.push('Cancel');

        const answer = await vscode.window.showQuickPick(options, {
            title: `Are you sure you want to execute ${apexCellCount} anonymous apex cell(s)?`
        });

        // Filter cells based on user selection
        if (!answer || answer === 'Cancel') {
            return [];
        } else if (answer === 'Execute only Apex') {
            return cells.filter(cell => cell.document.languageId === 'apex-anon');
        } else if (answer === 'Execute only SOQLs') {
            return cells.filter(cell => cell.document.languageId === 'soql');
        }
        
        return [...cells];
    }

    /**
     * Executes a single notebook cell
     * 
     * @param cell The cell to execute
     */
    private async executeCell(cell: vscode.NotebookCell): Promise<void> {
        const executionTask = this.controller.createNotebookCellExecution(cell);
        executionTask.start(Date.now());
        executionTask.clearOutput();
        
        let success = false;
        
        try {
            const targetUsername = await this.determineTargetOrg(cell);
            const connection = await SalesforceHandler.getSalesforceConnection(targetUsername);
            
            // Execute based on language type
            switch (cell.document.languageId) {
                case 'apex-anon':
                    success = await this.executeApex(cell, connection, executionTask);
                    break;
                case 'soql':
                    success = await this.executeSoql(cell, connection, executionTask);
                    break;
                default:
                    throw new Error(`Unsupported language: ${cell.document.languageId}`);
            }
        } catch (error: any) {
            console.error(error);
            executionTask.replaceOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error(error)
            ]));
        } finally {
            executionTask.end(success, Date.now());
        }
    }

    /**
     * Determines which Salesforce org to use for execution
     * 
     * @param cell The notebook cell
     * @returns The target username/org to use
     */
    private async determineTargetOrg(cell: vscode.NotebookCell): Promise<string> {
        // Check if cell has a specific target org set
        let targetUsername = cell.metadata?.targetOrg;
        
        if (!targetUsername) {
            targetUsername = await SalesforceHandler.getDefaultUsernameOrAlias();
            const promptTargetOrgConfig = vscode.workspace.getConfiguration().get(
                CONSTANTS.SETTING_KEY_PROMPT_FOR_TARGET_ORG
            );
            
            if (promptTargetOrgConfig === CONSTANTS.TARGET_ORG_DIALOG_OPTION_ALWAYS_PROMPT) {
                targetUsername = await this.promptForOrg(targetUsername);
            }
        }
        
        return targetUsername;
    }

    /**
     * Prompts user to select a Salesforce org
     * 
     * @param defaultUsername Default username to use if none selected
     * @returns Selected username or default
     */
    private async promptForOrg(defaultUsername: string): Promise<string> {
        const options: vscode.QuickPickItem[] = [{
            label: defaultUsername,
            detail: '(Default Username)'
        }];
        
        // Add available orgs
        const aliasMap = await SalesforceHandler.getListOfUsernames();
        for (const alias of Object.keys(aliasMap).sort()) {
            if (alias !== defaultUsername) {
                options.push({
                    label: alias,
                    detail: aliasMap[alias]
                });
            }
        }
        
        options.push({ label: 'Cancel' });
        
        const answer = await vscode.window.showQuickPick(options, {
            title: 'Which org would you like to execute this cell in?'
        });
        
        return (answer && answer.label !== 'Cancel') ? answer.label : defaultUsername;
    }

    /**
     * Executes an Apex code cell
     * 
     * @param cell The notebook cell
     * @param connection Salesforce connection
     * @param executionTask The execution task
     * @returns Success status
     */
    public async executeApex(
        cell: vscode.NotebookCell, 
        connection: sfdc_core.Connection, 
        executionTask: vscode.NotebookCellExecution
    ): Promise<boolean> {
        const executor = new sfdc.ExecuteService(connection);
        const response = await executor.executeAnonymous({
            apexCode: cell.document.getText()
        });
        
        // Create result text for possible simple output
        const resultText = this.generateResultText(response);
        
        if (response.logs && response.logs.trim()) {
            // Generate HTML log analysis
            await this.handleApexLogsOutput(response, cell, executionTask);
        } else {
            // Handle cases without logs (errors or simple success)
            await this.handleNoLogsOutput(response, cell, executionTask, resultText);
        }
        
        return response.compiled && response.success;
    }

    /**
     * Generates result text from Apex execution response
     * 
     * @param response The Apex execution response
     * @returns Formatted result text
     */
    private generateResultText(response: sfdc.ExecuteAnonymousResponse): string {
        let resultText: string;
        
        if (response.compiled && response.success) {
            resultText = "✓ Executed successfully";
        } else if (!response.compiled) {
            resultText = "❌ Compilation failed";
        } else {
            resultText = "❌ Execution failed";
        }
        
        // Add diagnostic information if available
        if (response.diagnostic) {
            const diagnostic = this.extractDiagnostic(response.diagnostic);
            
            if (diagnostic) {
                if (diagnostic.compileProblem) {
                    resultText += `\nCompilation problem: ${diagnostic.compileProblem}`;
                }
                if (diagnostic.exceptionMessage) {
                    resultText += `\nException: ${diagnostic.exceptionMessage}`;
                }
                
                const line = diagnostic.line || diagnostic.lineNumber;
                const column = diagnostic.column || diagnostic.columnNumber;
                if (line !== undefined && column !== undefined) {
                    resultText += `\nLocation: Line ${line}, Column ${column}`;
                }
            }
        }
        
        return resultText;
    }

    /**
     * Extracts and normalizes diagnostic information from Apex execution response
     * 
     * @param diagnostic The diagnostic object or array
     * @returns Normalized diagnostic object
     */
    private extractDiagnostic(diagnostic: any): any {
        if (!diagnostic) {
            return null;
        }
        
        return Array.isArray(diagnostic) ? diagnostic[0] : diagnostic;
    }

    /**
     * Handles output when logs are available
     * 
     * @param response The Apex execution response
     * @param cell The notebook cell
     * @param executionTask The execution task
     */
    private async handleApexLogsOutput(
        response: sfdc.ExecuteAnonymousResponse, 
        cell: vscode.NotebookCell, 
        executionTask: vscode.NotebookCellExecution
    ): Promise<void> {
        // Ensure logs is a string
        const logs = response.logs || '';
        const logAnalysis = LogAnalyzerHandler.analyzeApexLog(logs);
        
        // Enrich log analysis with diagnostic errors if there were any
        if (response.diagnostic && !response.success) {
            this.addDiagnosticErrorsToLogAnalysis(response.diagnostic, logAnalysis);
        }
        
        // Generate HTML with the log analysis
        const analysisHtml = LogAnalyzerHandler.renderLogAnalysisAsHtml(
            logAnalysis, 
            logs, 
            cell.document.getText()
        );
        
        // Output only the HTML analysis, no separate text
        executionTask.appendOutput(new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(analysisHtml, 'text/html')
        ]));
    }

    /**
     * Handles output when no logs are available
     * 
     * @param response The Apex execution response
     * @param cell The notebook cell
     * @param executionTask The execution task
     * @param resultText The result text to use for success case
     */
    private async handleNoLogsOutput(
        response: sfdc.ExecuteAnonymousResponse, 
        cell: vscode.NotebookCell, 
        executionTask: vscode.NotebookCellExecution,
        resultText: string
    ): Promise<void> {
        // Handle error case
        if (!response.success || !response.compiled) {
            const emptyLogAnalysis = this.createEmptyLogAnalysis();
            
            // Add error from diagnostic if available
            if (response.diagnostic) {
                this.addDiagnosticErrorsToLogAnalysis(response.diagnostic, emptyLogAnalysis);
            }
            
            // Add generic error if no specific errors found
            if (emptyLogAnalysis.errors.length === 0) {
                emptyLogAnalysis.errors.push({
                    message: !response.compiled ? "Code failed to compile" : "Execution failed"
                });
            }
            
            // Generate HTML for the error-only analysis
            const errorHtml = LogAnalyzerHandler.renderLogAnalysisAsHtml(
                emptyLogAnalysis, 
                "", 
                cell.document.getText()
            );
            
            executionTask.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(errorHtml, 'text/html')
            ]));
        } else {
            // Success case - just show a simple success message
            executionTask.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(resultText, 'text/plain')
            ]));
        }
    }

    /**
     * Adds diagnostic errors to log analysis
     * 
     * @param diagnostic The diagnostic object or array
     * @param logAnalysis The log analysis to update
     */
    private addDiagnosticErrorsToLogAnalysis(diagnostic: any, logAnalysis: LogAnalysis): void {
        const diag = this.extractDiagnostic(diagnostic);
        
        if (!diag) {
            return;
        }
        
        // Add exception message if not already captured
        if (diag.exceptionMessage && 
            !logAnalysis.errors.some(e => e.message.includes(diag.exceptionMessage))) {
            logAnalysis.errors.push({
                message: diag.exceptionMessage,
                lineNumber: diag.line || diag.lineNumber,
                columnNumber: diag.column || diag.columnNumber
            });
        }
        
        // Add compilation problem if not already captured
        if (diag.compileProblem && 
            !logAnalysis.errors.some(e => e.message.includes(diag.compileProblem))) {
            logAnalysis.errors.push({
                message: `Compilation Error: ${diag.compileProblem}`,
                lineNumber: diag.line || diag.lineNumber,
                columnNumber: diag.column || diag.columnNumber
            });
        }
    }

    /**
     * Creates an empty log analysis object
     * 
     * @returns Empty log analysis structure
     */
    private createEmptyLogAnalysis(): LogAnalysis {
        return {
            summary: {
                totalTimeMs: 0,
                dbTimeMs: 0,
                heapSize: 0,
                numDmlStatements: 0,
                numSoqlQueries: 0,
                numDatabaseCalls: 0
            },
            debugLines: [],
            timeline: [],
            errors: [],
            limits: [],
            governorLimits: [],
            methodCalls: [],
            hasCoverageInfo: false,
            totalExecutionTimeMs: 0
        };
    }

    /**
     * Executes a SOQL query cell
     * 
     * @param cell The notebook cell
     * @param connection Salesforce connection
     * @param executionTask The execution task
     * @returns Success status
     */
    public async executeSoql(
        cell: vscode.NotebookCell, 
        connection: sfdc_core.Connection, 
        executionTask: vscode.NotebookCellExecution
    ): Promise<boolean> {
        const queryResult = await connection.query(cell.document.getText());
        const htmlOutput = this.formatSoqlResultsAsHtml(queryResult.records, queryResult.totalSize);
        
        const outputItems: vscode.NotebookCellOutputItem[] = [
            vscode.NotebookCellOutputItem.text(htmlOutput, 'text/html')
        ];
        
        // Add JSON output if configured
        const shouldShowJson = vscode.workspace.getConfiguration().get(CONSTANTS.SETTING_KEY_DISPLAY_JSON_OUTPUT);
        if (shouldShowJson === true && queryResult.records.length > 0) {
            outputItems.push(vscode.NotebookCellOutputItem.json(queryResult.records));
        }
        
        executionTask.appendOutput(new vscode.NotebookCellOutput(outputItems));
        return queryResult.done;
    }

    /**
     * Formats SOQL query results as HTML table
     * 
     * @param records The records returned from the query
     * @param totalRecords Total number of records
     * @returns HTML table representation
     */
    private formatSoqlResultsAsHtml(records: {[key: string]: any}[], totalRecords?: number): string {
        if (!records || records.length === 0) {
            return 'No records found';
        }
        
        // Extract field headers (excluding 'attributes')
        const headers = Object.keys(records[0]).filter(key => key !== 'attributes');
        
        // Build HTML output
        let output = '';
        
        // Add record count if available
        if (totalRecords != null && totalRecords > 0) {
            output += `<div>Total Records: ${totalRecords}</div>`;
        }
        
        // Generate table
        output += '<table>';
        
        // Add header row
        output += '<tr>' + headers.map(header => 
            `<th style="text-align:left">${header}</th>`
        ).join('') + '</tr>';
        
        // Add data rows
        for (const record of records) {
            output += '<tr>' + headers.map(header => {
                const cellData = this.formatCellData(record[header]);
                return `<td style="text-align:left">${cellData}</td>`;
            }).join('') + '</tr>';
        }
        
        output += '</table>';
        return output;
    }
    
    /**
     * Formats individual cell data for HTML display
     * 
     * @param data The cell data
     * @returns Formatted cell data
     */
    private formatCellData(data: any): string {
        if (data == null) {
            return ' ';
        }
        
        if (typeof data === 'object') {
            // Handle related list
            if (data.records) {
                return `<div style="padding: 10px;">${
                    this.formatSoqlResultsAsHtml(data.records as {[key: string]: any}[])
                }</div>`;
            }
            
            // Handle linked record
            if (data.attributes) {
                const clonedData = {...data};
                delete clonedData.attributes;
                return JSON.stringify(clonedData);
            }
            
            return JSON.stringify(data);
        }
        
        // Handle string data with newlines
        return String(data).replace(/\r\n|\n/, '<br/>');
    }

    /**
     * Cleans up resources
     */
    public dispose(): void {
        // Nothing to dispose yet
    }
}
