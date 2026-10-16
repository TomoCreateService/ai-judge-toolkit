export default async function* reporter(source) {
  let passed = 0;
  let failed = 0;
  for await (const event of source) {
    if (event.type === "test:pass") {
      passed += 1;
      yield `合格: ${event.data.name}\n`;
    }
    if (event.type === "test:fail") {
      failed += 1;
      yield `不合格: ${event.data.name}\n${event.data.details.error.message}\n`;
    }
    if (event.type === "test:stderr") yield event.data.message;
  }
  yield `\n合格${passed}件・不合格${failed}件\n`;
}
