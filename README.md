# Anonymous Apex Notebook Extended

## Features

Allows the creation of an "Apex Notebook" which enables the execution of Anonymous Apex and SOQL queries within the UI of VSCode's Notebook framework. To get started, use the `Create: New Apex Notebook` in the command prompt. 

### Enhanced Features

- **Collapsible Log Analysis**: Detailed and organized log output with a collapsible interface
- **Execution Datetime Display**: Shows the exact execution time of your Apex code
- **Governor Limits Visualization**: Visual indicators of governor limit usage
- **Debug Statement Highlighting**: Improved display of debug statements
- **Error Reporting**: Better visualization of errors and exceptions
- **Raw Log Toggle**: Easily switch between analyzed and raw log views

![Demo](media/demo.gif)

## Commands

- "Create: New Apex Notebook" - Creates a new apex notebook for use
- "Apex Notebook: Open in Apex Log Analyzer" - Opens the current log in the full Apex Log Analyzer extension

## Requirements

The following extensions are required due to the language support:
- [Apex (Salesforce)](https://marketplace.visualstudio.com/items?itemName=salesforce.salesforcedx-vscode-apex) 
- [SOQL (Salesforce)](https://marketplace.visualstudio.com/items?itemName=salesforce.salesforcedx-vscode-soql) 

## Extension Settings

This extension contributes the following settings:

* `anonymous-apex-notebook.apexConfirmDialogPreference`: Picklist which dictates whether running Apex should confirm the action of executing the anonymous apex script.
* `anonymous-apex-notebook.enableSoqlJsonOutput`: When executing a SOQL, should the JSON of the SOQL request be displayed in addition to the HTML table view?
* `anonymous-apex-notebook.showApexDebugOnlyCellOutput`: Should Anon Apex cells show an additional "Debug Only" output?
* `anonymous-apex-notebook.promptForTargetOrgWhenExecutingCells`: When executing cells, prompt for a target org?

## Credits

This extension was originally created by Jake Kirkman and extended by Andrii Leshchuk with additional features for improved log analysis and output display.

## Known Issues

None at the moment, let me know if you run into anything via github issues!
