from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel
import base64
from sqlalchemy.orm import Session
from .database import get_db, Submission
from .omr_engine import grade_sheet_opencv

app = FastAPI()

class ApiPayload(BaseModel):
    action: str
    sessionToken: str = None
    classId: str = None
    studentId: str = None
    testSet: str = None
    items: list = []
    base64Image: str = None
    answers: dict = None

@app.post("/api")
def main_gateway(payload: ApiPayload, db: Session = Depends(get_db)):
    
    # --- 1. OMR Vision Route ---
    if payload.action == "AI_VISION_GRADE":
        try:
            # Strip data:image/jpeg;base64, prefix
            encoded_data = payload.base64Image.split(",")[1] if "," in payload.base64Image else payload.base64Image
            img_bytes = base64.b64decode(encoded_data)
            
            detected_answers, raw_score, total_points, breakdown = grade_sheet_opencv(
                img_bytes, payload.items, payload.testSet
            )
            
            percentage = round((raw_score / total_points) * 100, 2) if total_points > 0 else 0
            is_passed = percentage >= 70 # Can grab dynamically from class setting
            
            return {
                "success": True,
                "answers": detected_answers,
                "rawScore": raw_score,
                "totalPoints": total_points,
                "percentage": percentage,
                "isPassed": is_passed,
                "status": "PASSED" if is_passed else "FAILED",
                "itemBreakdown": breakdown
            }
        except Exception as e:
            return {"success": False, "message": f"Computer Vision Error: {str(e)}"}
            
    # --- 2. Database Save Route ---
    elif payload.action == "SCANNER_SUBMIT":
        try:
            # Calculate final grade locally for the DB
            raw = 0
            tot = 0
            for it in payload.items:
                tot += int(it.get('points', 1))
                if str(payload.answers.get(str(it['itemNo']))) == it.get('setA' if payload.testSet == 'A' else 'setB'):
                    raw += int(it.get('points', 1))
            
            pct = round((raw / tot) * 100, 2) if tot > 0 else 0
            status = "PASSED" if pct >= 70 else "FAILED"
            
            new_sub = Submission(
                class_id=payload.classId,
                student_id=payload.studentId,
                test_set=payload.testSet,
                raw_score=raw,
                total_points=tot,
                percentage=pct,
                status=status,
                answers=payload.answers
            )
            db.add(new_sub)
            db.commit()
            
            return {"success": True, "rawScore": raw, "totalPoints": tot, "percentage": pct, "status": status}
        except Exception as e:
            db.rollback()
            return {"success": False, "message": str(e)}

    # Add your GET_CLASSES, VALIDATE_SESSION routing here connected to PostgreSQL
    return {"success": False, "message": "Action not recognized by Python Gateway."}