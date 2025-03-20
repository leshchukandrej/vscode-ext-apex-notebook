// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import ApexNotebookController from './notebook/apexNotebookController';
import ApexNotebookSerializer from './notebook/apexNotebookSerializer';
import * as CONSTANTS from './constants';
import * as DataHandler from './handlers/dataHandler';
import * as LogHandler from './handlers/logHandler';
import * as SalesforceHandler from './handlers/salesforceHandler';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "anonymous-apex-notebook" is now active!');

    DataHandler.initiate(context);
    LogHandler.initiate();

    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer(CONSTANTS.NOTEBOOK_TYPE, new ApexNotebookSerializer())
    );
    context.subscriptions.push(
        new ApexNotebookController()
    );

    // Add command to change org for a cell
    context.subscriptions.push(
        vscode.commands.registerCommand('anonymous-apex-notebook.selectOrg', async (cell: vscode.NotebookCell) => {
            console.log('Select org command triggered for cell');
            const defaultUsername = await SalesforceHandler.getDefaultUsernameOrAlias();
            const aliasMap = await SalesforceHandler.getListOfUsernames();
            
            const options: vscode.QuickPickItem[] = [
                {
                    label: defaultUsername,
                    description: '(Default)',
                    detail: aliasMap[defaultUsername]
                }
            ];

            // Add other orgs
            for (const alias of Object.keys(aliasMap).sort()) {
                if (alias === defaultUsername) continue;
                options.push({
                    label: alias,
                    detail: aliasMap[alias]
                });
            }

            // Add option to clear org selection
            options.push({
                label: 'Clear Org Selection',
                description: 'Use default org settings'
            });

            const selected = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select target org for this cell'
            });

            if (selected) {
                const notebook = cell.notebook;
                const edit = new vscode.WorkspaceEdit();
                const cellIndex = notebook.getCells().indexOf(cell);

                // Create new cell with updated metadata
                const newCell = new vscode.NotebookCellData(
                    cell.kind,
                    cell.document.getText(),
                    cell.document.languageId
                );
                
                // Set or clear metadata
                if (selected.label === 'Clear Org Selection') {
                    newCell.metadata = { ...cell.metadata };
                    delete newCell.metadata.targetOrg;
                } else {
                    newCell.metadata = {
                        ...cell.metadata,
                        targetOrg: selected.label
                    };
                }

                // Apply the edit
                const nbEdit = vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cellIndex, cellIndex + 1), [newCell]);
                edit.set(notebook.uri, [nbEdit]);
                await vscode.workspace.applyEdit(edit);
            }
        })
    );

    // Register command to extract log from cell output and open it in the Apex Log Analyzer
    context.subscriptions.push(
        vscode.commands.registerCommand('anonymous-apex-notebook.openLogFromCell', async () => {
            console.log('Opening log from cell...');
            try {
                // Get the active notebook editor
                const editor = vscode.window.activeNotebookEditor;
                if (!editor) {
                    console.log('No active notebook editor found');
                    return;
                }

                // Get the selected cell
                const cell = editor.selection 
                    ? editor.notebook.cellAt(editor.selection.start) 
                    : undefined;
                
                if (!cell || cell.outputs.length === 0) {
                    console.log('No cell selected or cell has no outputs');
                    vscode.window.showInformationMessage('Please select a cell with outputs');
                    return;
                }

                console.log('Cell found, checking outputs...');
                // Look for HTML output
                for (const output of cell.outputs) {
                    for (const item of output.items) {
                        if (item.mime === 'text/html') {
                            // Get the HTML content as text
                            const content = new TextDecoder().decode(item.data);
                            
                            // Try to find the raw log text in the HTML using the data attribute approach
                            // The new pattern includes a unique ID in the format: logDataScript_log_[random]
                            const logScriptMatch = content.match(/<script id="logDataScript_log_[^"]*"[^>]*data-log-content="([^"]*)"[^>]*>/);
                            
                            if (logScriptMatch && logScriptMatch[1]) {
                                try {
                                    console.log('Found log text in HTML data attribute, attempting to parse...');
                                    
                                    // Unescape the HTML entities first
                                    const unescapedHtml = logScriptMatch[1]
                                        .replace(/&amp;/g, '&')
                                        .replace(/&lt;/g, '<')
                                        .replace(/&gt;/g, '>')
                                        .replace(/&quot;/g, '"')
                                        .replace(/&#039;/g, "'");
                                    
                                    // Parse the JSON string
                                    let logText: string;
                                    try {
                                        logText = JSON.parse(unescapedHtml);
                                    } catch (parseError) {
                                        console.log('JSON parsing failed, using text as-is:', parseError);
                                        logText = unescapedHtml;
                                    }
                                    
                                    console.log('Log text extracted successfully, opening in Apex Log Analyzer...');
                                    
                                    // Show a progress notification
                                    vscode.window.withProgress({
                                        location: vscode.ProgressLocation.Notification,
                                        title: 'Opening log in Apex Log Analyzer',
                                        cancellable: false
                                    }, async (progress) => {
                                        progress.report({ increment: 50, message: 'Preparing log file...' });
                                        
                                        // Open in the Apex Log Analyzer
                                        await vscode.commands.executeCommand('anonymous-apex-notebook.openInApexLogAnalyzer', logText);
                                        
                                        progress.report({ increment: 50, message: 'Complete' });
                                        return Promise.resolve();
                                    });
                                    
                                    return;
                                } catch (error) {
                                    console.error('Error extracting log text from data attribute:', error);
                                    vscode.window.showErrorMessage('Failed to parse log text from the output.');
                                }
                            } else {
                                // Fallback to the old approach for backward compatibility
                                const logMatch = content.match(/const\s+rawLogText\s+=\s+JSON\.parse\('(.+?)'\)/);
                                
                                if (logMatch && logMatch[1]) {
                                    try {
                                        console.log('Found log text using old approach, attempting to parse...');
                                        
                                        // First try direct parsing
                                        let logText: string;
                                        try {
                                            logText = JSON.parse(logMatch[1]);
                                        } catch (parseError) {
                                            // If that fails, try a different approach by replacing escaped characters
                                            console.log('Initial JSON parse failed, trying alternative parsing approach...');
                                            const decodedText = logMatch[1]
                                                .replace(/\\'/g, "'")
                                                .replace(/\\n/g, '\n')
                                                .replace(/\\r/g, '\r')
                                                .replace(/\\t/g, '\t')
                                                .replace(/\\\\/g, '\\');
                                            
                                            logText = decodedText;
                                        }
                                        
                                        console.log('Log text extracted successfully, opening in Apex Log Analyzer...');
                                        
                                        // Show a progress notification
                                        vscode.window.withProgress({
                                            location: vscode.ProgressLocation.Notification,
                                            title: 'Opening log in Apex Log Analyzer',
                                            cancellable: false
                                        }, async (progress) => {
                                            progress.report({ increment: 50, message: 'Preparing log file...' });
                                            
                                            // Open in the Apex Log Analyzer
                                            await vscode.commands.executeCommand('anonymous-apex-notebook.openInApexLogAnalyzer', logText);
                                            
                                            progress.report({ increment: 50, message: 'Complete' });
                                            return Promise.resolve();
                                        });
                                        
                                        return;
                                    } catch (error) {
                                        console.error('Error parsing log text from HTML:', error);
                                        vscode.window.showErrorMessage('Failed to parse log text from the output.');
                                    }
                                }
                            }
                        }
                    }
                }
                
                console.log('No log text found in the cell outputs');
                vscode.window.showInformationMessage('No log data found in this cell\'s output.');
            } catch (error) {
                console.error('Error opening log from cell:', error);
                vscode.window.showErrorMessage(`Error opening log: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    // Register command to open log in Apex Log Analyzer
    context.subscriptions.push(
        vscode.commands.registerCommand('anonymous-apex-notebook.openInApexLogAnalyzer', async (logText: string) => {
            console.log('Opening log in Apex Log Analyzer...');
            try {
                // Check if the Apex Log Analyzer extension is installed
                const apexLogAnalyzerExtension = vscode.extensions.getExtension('financialforce.lana');
                
                if (!apexLogAnalyzerExtension) {
                    console.log('Apex Log Analyzer extension not found. Prompting for installation...');
                    const installOption = 'Install';
                    const response = await vscode.window.showInformationMessage(
                        'The Apex Log Analyzer extension is required to view detailed log analysis.',
                        installOption
                    );
                    
                    if (response === installOption) {
                        console.log('Installing Apex Log Analyzer extension...');
                        await vscode.commands.executeCommand('workbench.extensions.installExtension', 'financialforce.lana');
                        vscode.window.showInformationMessage('Please restart VS Code after installation completes.');
                    }
                    return;
                }
                
                console.log('Creating temporary log file...');
                // Create a temporary file and write the log text to it
                const tempDir = os.tmpdir();
                const tempFile = path.join(tempDir, `apex-log-${Date.now()}.log`);
                fs.writeFileSync(tempFile, logText);
                
                // Open the log file in the Apex Log Analyzer
                const uri = vscode.Uri.file(tempFile);
                console.log(`Opening log file with the lana.showLogAnalysis command...`);
                await vscode.commands.executeCommand('lana.showLogAnalysis', uri);
                console.log('Successfully opened log in Apex Log Analyzer');
            } catch (error) {
                console.error('Error opening log in Apex Log Analyzer:', error);
                vscode.window.showErrorMessage(`Failed to open log in Apex Log Analyzer: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    // Register a status bar item provider for the Open in Apex Log Analyzer button
    const logAnalyzerProvider = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
        CONSTANTS.NOTEBOOK_TYPE,
        {
            provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
                if (cell.outputs && cell.outputs.length > 0) {
                    // Check if any of the outputs contain HTML with log data
                    let hasLogData = false;
                    
                    // Look for HTML output with log data
                    for (const output of cell.outputs) {
                        for (const item of output.items) {
                            if (item.mime === 'text/html') {
                                const content = new TextDecoder().decode(item.data);
                                // Check for our new log data script tag with unique ID
                                if (content.includes('logDataScript_log_') && content.includes('data-log-content')) {
                                    hasLogData = true;
                                    break;
                                }
                                // Fallback for backward compatibility
                                if (content.includes('rawLogText')) {
                                    hasLogData = true;
                                    break;
                                }
                            }
                        }
                        if (hasLogData) break;
                    }
                    
                    if (hasLogData) {
                        return [
                            {
                                text: '$(search) Open Log in Analyzer',
                                tooltip: 'Open this cell\'s log in the Apex Log Analyzer',
                                command: 'anonymous-apex-notebook.openLogFromCell',
                                alignment: vscode.NotebookCellStatusBarAlignment.Right,
                                priority: 10,
                                accessibilityInformation: {
                                    label: 'Open the log in Apex Log Analyzer',
                                    role: 'button'
                                }
                            }
                        ];
                    }
                }
                return [];
            }
        }
    );
    
    context.subscriptions.push(logAnalyzerProvider);

    // Create a provider for cell status bar items
    const orgSelectorProvider = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
        CONSTANTS.NOTEBOOK_TYPE, 
        {
            async provideCellStatusBarItems(cell: vscode.NotebookCell): Promise<vscode.NotebookCellStatusBarItem[]> {
                if (cell.kind === vscode.NotebookCellKind.Code) {
                    console.log('Providing cell status bar item for code cell');
                    
                    const defaultUsername = await SalesforceHandler.getDefaultUsernameOrAlias();
                    const targetOrg = cell.metadata?.targetOrg || defaultUsername;
                    
                    return [
                        {
                            text: `$(organization) ${targetOrg}`,
                            tooltip: 'Click to change target org for this cell',
                            command: 'anonymous-apex-notebook.selectOrg',
                            alignment: vscode.NotebookCellStatusBarAlignment.Right,
                            priority: 1,
                            accessibilityInformation: {
                                label: 'Select target org for cell execution',
                                role: 'button'
                            }
                        }
                    ];
                }
                return [];
            }
        }
    );
    
    context.subscriptions.push(orgSelectorProvider);

    // Register command to create new notebook
    context.subscriptions.push(
        vscode.commands.registerCommand(
            CONSTANTS.COMMAND_NAME_NEW_NOTEBOOK,
            async () => {
                let notebook = await vscode.workspace.openNotebookDocument(
                    CONSTANTS.NOTEBOOK_TYPE,
                    new vscode.NotebookData([
                        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '// Your anonymous apex script goes here!', 'apex-anon'),
                        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT Id, Name FROM Account', 'soql'),
                    ])
                );
                vscode.window.showNotebookDocument(notebook);
            }
        )
    );
}

// this method is called when your extension is deactivated
export function deactivate() {}

