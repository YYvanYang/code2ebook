const { readFileSync, writeFileSync } = require('fs');

// Reading standard input (STDIN)
const input = readFileSync(0, 'utf-8');

function modifyAttributes(attributes, additionalClasses) {
    let classAttr = attributes.find(attr => attr[0] === 'class');
    if (classAttr) {
        classAttr[1] += ` ${additionalClasses}`;
    } else {
        attributes.push(['class', additionalClasses]);
    }
}

function addTailwindClasses(element) {
    if (element.t && element.c) {
        let attributes;
        // For elements that directly contain attributes
        if (Array.isArray(element.c[1]) && element.c[1].some(attr => Array.isArray(attr) && attr[0] === 'class')) {
            attributes = element.c[1];
        }
        // For elements with a different structure, adjust the logic to find the attributes array

        // Once attributes are identified or if the structure is different, modify them
        if (attributes) {
            switch (element.t) {
                case 'Header':
                    modifyAttributes(attributes, `text-xl font-bold mb-4`);
                    break;
                case 'CodeBlock':
                    modifyAttributes(attributes, 'bg-gray-100 rounded-md p-4 mb-4 text-sm font-mono');
                    break;
                // Add more cases as needed
            }
        }
    }
}

function walk(node) {
    if (Array.isArray(node)) {
        node.forEach(walk);
    } else if (node && typeof node === 'object') {
        addTailwindClasses(node);
        Object.values(node).forEach(walk);
    }
}

// Parse the input JSON
const ast = JSON.parse(input);

// Walk and modify the AST
walk(ast);

// Output the modified JSON
process.stdout.write(JSON.stringify(ast));