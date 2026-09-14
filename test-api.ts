async function testAPI() {
  try {
    const res = await fetch(
      "http://127.0.0.1:5000/api/v1/slots?salonId=a9f534d3-dda0-449a-95f7-3f3cfbc020f9&date=2026-09-15",
    );
    const data = await res.json();
    console.log(JSON.stringify(data.data.slice(0, 2), null, 2));
  } catch (e) {
    console.error(e);
  }
}
testAPI();
