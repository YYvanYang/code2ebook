function addTailwindClasses(element) {
  if (element.t === 'Header') {
    const level = element.c[0];
    element.c[1][0].c.push({
      t: 'Str',
      c: `text-${level}xl font-bold mb-${level}`
    });
  } else if (element.t === 'Para') {
    element.c.push({
      t: 'Str',
      c: 'text-base text-gray-700 mb-4 leading-relaxed'
    });
  } else if (element.t === 'BlockQuote') {
    element.c.push({
      t: 'Str',
      c: 'border-l-4 border-gray-300 pl-4 text-gray-600 italic bg-gray-100 rounded-md'
    });
  } else if (element.t === 'CodeBlock') {
    element.c[1].push({
      t: 'Str',
      c: 'bg-gray-100 rounded-md p-4 mb-4 text-sm font-mono'
    });
  } else if (element.t === 'BulletList') {
    element.c.forEach(item => {
      item.c.push({
        t: 'Str',
        c: 'list-disc text-base text-gray-600 mb-2'
      });
    });
  } else if (element.t === 'OrderedList') {
    element.c.forEach(item => {
      item.c.push({
        t: 'Str',
        c: 'list-decimal text-base text-gray-600 mb-2'
      });
    });
  } else if (element.t === 'Link') {
    element.c[1].push({
      t: 'Str',
      c: 'text-blue-600 underline'
    });
  } else if (element.t === 'Image') {
    element.c[1].push({
      t: 'Str',
      c: 'mb-4'
    });
  }
}

function Pandoc(element) {
  if (Array.isArray(element)) {
    element.forEach(Pandoc);
  } else if (element.t) {
    addTailwindClasses(element);
    Object.keys(element).forEach(key => {
      Pandoc(element[key]);
    });
  }
  return element;
}

// 从标准输入读取 JSON
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', () => {
  const json = JSON.parse(input);
  const output = JSON.stringify(Pandoc(json));
  process.stdout.write(output);
});