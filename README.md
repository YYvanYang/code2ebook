# GitHub Repository to EPUB Converter

This is a Node.js script that converts a GitHub repository into an EPUB file. It clones the repository, processes the code files, applies syntax highlighting, and generates an EPUB file with a table of contents.

## Features

- Clones a GitHub repository to a local directory
- Supports various code file extensions (`.js`, `.ts`, `.py`, `.jsx`, `.tsx`, `.rs`, `.md`)
- Applies syntax highlighting to code files using the `highlight.js` library
- Generates an EPUB file with a table of contents, including the relative paths of code files
- Adds a timestamp to the generated EPUB file name

## Prerequisites

Before running the script, make sure you have the following installed:

- Node.js
- Pandoc
- Git

## Installation

1. Clone this repository to your local machine:
```bash
git clone https://github.com/your-username/repo-to-epub.git
```

2. Navigate to the project directory:
```
cd repo-to-epub
```
3. Install the required Node.js packages:
```bash
npm install
```

## Configuration

1. Create a `.env` file in the project root directory.

2. Add the following line to the `.env` file, replacing `<repository-url>` with the URL of the GitHub repository you want to convert:
REPO_URL=<repository-url>

## Usage

1. Run the script using the following command:
```bash
node index.js
```

2. The script will clone the specified GitHub repository, process the code files, and generate an EPUB file.

3. The generated EPUB file will be saved in the project root directory with a timestamp appended to the file name, e.g., `repo-name_YYYYMMDDHHmmss.epub`.

4. The script will output the generated EPUB file name and its file path.

## Customization

- If you want to customize the supported code file extensions, modify the `codeExtensions` array in the `main` function.

- If you want to add additional Pandoc options or metadata, modify the `pandocArgs` array in the `generateEpub` function.

## License

This project is licensed under the [MIT License](LICENSE).