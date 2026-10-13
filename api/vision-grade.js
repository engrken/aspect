import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  const { base64Image, items, passingPercentage } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'Missing GEMINI_API_KEY environment variable.' });
  }

  if (!base64Image || !items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Missing exam image or item configuration.' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const cleanBase64 = base64Image.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");

    const prompt = `
You are an expert Optical Mark Recognition (OMR) system evaluating an exam answer sheet.
Look carefully at the provided photo of the answer sheet:
1. Locate the Student ID.
2. Locate the active Test Set ("SET A" or "SET B"). Default to "A" if unclear.
3. For each numbered question check choices A, B, C, D. Detect ONLY the bubble that has been darkened.
Return strictly a valid JSON object:
{
  "studentId": "string",
  "testSet": "A" or "B",
  "answers": {
    "1": "A" | "B" | "C" | "D"
  }
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const parsedData = JSON.parse(response.text.trim());
    const detectedAnswers = parsedData.answers || {};
    const activeSet = (parsedData.testSet || 'A').toUpperCase();
    const targetKeyProp = activeSet === 'B' ? 'setB' : 'setA';

    let rawScore = 0;
    let totalPoints = 0;
    const itemBreakdown = [];

    items.forEach(item => {
      const pts = Number(item.points) || 1;
      totalPoints += pts;
      const correct = (item[targetKeyProp] || '').toUpperCase().trim();
      let studentAns = (detectedAnswers[item.itemNo] || '').toUpperCase().trim();

      if (item.type === 'TF') {
        if (studentAns === 'A') studentAns = 'T';
        if (studentAns === 'B') studentAns = 'F';
      }

      const isCorrect = studentAns && (studentAns === correct || correct === '*' || correct === 'ALL');
      if (isCorrect) rawScore += pts;

      itemBreakdown.push({
        itemNo: item.itemNo,
        studentAnswer: studentAns || '(Blank)',
        correctAnswer: correct,
        isCorrect: isCorrect
      });
    });

    const passThreshold = Math.ceil(totalPoints * ((passingPercentage || 70) / 100));
    const percentage = totalPoints > 0 ? Math.round((rawScore / totalPoints) * 10000) / 100 : 0;
    const isPassed = rawScore >= passThreshold;

    return res.status(200).json({
      success: true,
      studentId: parsedData.studentId,
      testSet: activeSet,
      answers: detectedAnswers,
      detectedMarksCount: Object.keys(detectedAnswers).length,
      rawScore,
      totalPoints,
      percentage,
      isPassed,
      status: isPassed ? 'PASSED' : 'FAILED',
      itemBreakdown
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}