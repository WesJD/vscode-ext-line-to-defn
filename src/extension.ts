import assert from "assert"
import { platform } from "os"
import * as vscode from "vscode"

const cssObjectToString = (obj: Record<string, string | number>): string =>
    Object.entries(obj)
        .map(([key, value]) => `${key}:${value};`)
        .join(" ")

const generateBackgroundImage = (option: "top-left-to-bottom-right" | "top-right-to-bottom-left"): string => {
    let svgXml = `<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">`
    switch (option) {
        case "top-left-to-bottom-right":
            svgXml += `<line 
				x1="0%" 
				y1="0%" 
				x2="100%" 
				y2="100%" 
				stroke="red" 
			/>`
            break
        case "top-right-to-bottom-left":
            svgXml += `<line 
				x1="100%" 
				y1="0%" 
				x2="0%" 
				y2="100%" 
				stroke="red" 
			/>`
            break
        default:
            const exhaustive: never = option
    }
    svgXml += "</svg>"

    return `url('data:image/svg+xml,${svgXml.split("\n").join("")}')`
}

const goldenLineHeightRatio = platform() === "darwin" ? 1.5 : 1.35
const minimumLineHeight = 8
const fontSize = vscode.workspace.getConfiguration("editor").get<number>("fontSize")
assert(fontSize)
const lineHeight = Math.max(minimumLineHeight, Math.round(goldenLineHeightRatio * fontSize))

const charsToCss = (chars: number): string => `${chars}ch`
const linesToCss = (lines: number): string => `${lines * lineHeight}px`

const centerOfRange = (start: number, end: number): number => start + Math.round((end - start) / 2)
const centerOfRangePos = (range: vscode.Range): vscode.Position =>
    new vscode.Position(
        centerOfRange(range.start.line, range.end.line),
        centerOfRange(range.start.character, range.end.character)
    )

const createRangeForPositions = (pos1: vscode.Position, pos2: vscode.Position): vscode.Range => {
    const minChar = Math.min(pos1.character, pos2.character)
    const maxChar = Math.max(pos1.character, pos2.character)
    const minLine = Math.min(pos1.line, pos2.line)
    const maxLine = Math.max(pos1.line, pos2.line)
    return new vscode.Range(new vscode.Position(minLine, minChar), new vscode.Position(maxLine, maxChar))
}

let lastDecoration: vscode.TextEditorDecorationType | null = null

export function activate(context: vscode.ExtensionContext) {
    console.log("activated")
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async () => {
            if (lastDecoration) {
                lastDecoration.dispose()
                lastDecoration = null
            }

            console.log("changed")
            const editor = vscode.window.activeTextEditor
            if (!editor) {
                console.log("no active editor")
                return
            }

            const selection = editor.selection
            const document = editor.document
            const selectionPos = selection.active
            const result: (vscode.Location | vscode.LocationLink)[] = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider",
                document.uri,
                selectionPos
            )
            const links: vscode.LocationLink[] = result.filter(
                (elem) =>
                    "targetUri" in elem &&
                    elem.targetUri.scheme === document.uri.scheme &&
                    elem.targetUri.path === document.uri.path &&
                    elem.targetUri.fsPath === document.uri.fsPath
            ) as vscode.LocationLink[]
            if (links.length === 0) {
                console.debug("no links")
                return
            }
            if (links.length > 1) {
                console.error("more than one link", links)
                return
            }

            console.log("the definition is: " + JSON.stringify(links[0], null, 2))
            const definitionRange = links[0].targetRange
            const definitionCenterPos = centerOfRangePos(definitionRange)

            const cursorWordRange = document.getWordRangeAtPosition(selectionPos)
            assert(cursorWordRange)
            const cursorWordCenterPos = centerOfRangePos(cursorWordRange)

            const range = createRangeForPositions(definitionCenterPos, cursorWordCenterPos)

            const posXChars = range.start.character
            const posYLines = range.start.line
            const widthChars = Math.abs(range.end.character - range.start.character)
            const heightLines = Math.abs(range.end.line - range.start.line)

            const backgroundImage = generateBackgroundImage(
                definitionCenterPos.character <= cursorWordCenterPos.character
                    ? "top-left-to-bottom-right"
                    : "top-right-to-bottom-left"
            )
            const cssString = cssObjectToString({
                position: "absolute",
                width: charsToCss(widthChars),
                height: linesToCss(heightLines),
                left: charsToCss(posXChars),
                top: linesToCss(posYLines),
                // 'background-color': 'white',
                display: "inline-block",
                "z-index": 1,
                "pointer-events": "none",
                "background-size": "100% 100%",
                "background-repeat": "no-repeat",
                "background-image": backgroundImage,
            })
            console.log(cssString)

            const decoration = vscode.window.createTextEditorDecorationType({
                before: {
                    contentText: "",
                    textDecoration: `none; ${cssString}`,
                },
                textDecoration: `none; position: relative;`,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            })

            editor.setDecorations(decoration, [range])
            lastDecoration = decoration
            console.log("displayed")
        })
    )
}
