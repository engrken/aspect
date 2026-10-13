import base64
import uuid
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

try:
    from .database import (
        get_db, RosterUser, AuthSession, CourseClass,
        ExamItem, Enrollment, Submission, hash_password, verify_password
    )
    from .omr_engine import grade_sheet_opencv
except ImportError:
    from database import (
        get_db, RosterUser, AuthSession, CourseClass,
        ExamItem, Enrollment, Submission, hash_password, verify_password
    )
    from omr_engine import grade_sheet_opencv

app = FastAPI()

class ApiPayload(BaseModel):
    action: str
    sessionToken: Optional[str] = None
    studentId: Optional[str] = None
    password: Optional[str] = None
    newPassword: Optional[str] = None
    fullName: Optional[str] = None
    email: Optional[str] = None
    section: Optional[str] = None
    facultyData: Optional[Dict[str, Any]] = None
    facultyId: Optional[str] = None
    classId: Optional[str] = None
    classData: Optional[Dict[str, Any]] = None
    studentData: Optional[Dict[str, Any]] = None
    studentsList: Optional[List[Dict[str, Any]]] = None
    studentIds: Optional[List[str]] = None
    items: Optional[List[Dict[str, Any]]] = None
    testSet: Optional[str] = "A"
    base64Image: Optional[str] = None
    answers: Optional[Dict[str, Any]] = None

def validate_token(db: Session, token: Optional[str]):
    if not token:
        return None
    sess = db.query(AuthSession).filter_by(token=token).first()
    if not sess or sess.expires_at < datetime.utcnow():
        return None
    return db.query(RosterUser).filter_by(student_id=sess.student_id).first()

@app.get("/")
@app.get("/api")
@app.get("/api/{full_path:path}")
def api_health(full_path: str = ""):
    return {"success": True, "status": "ok", "service": "ASPECT Python OMR Engine"}

@app.post("/")
@app.post("/api")
@app.post("/api/{full_path:path}")
def handle_api(payload: ApiPayload, full_path: str = "", db: Session = Depends(get_db)):
    try:
        act = payload.action

        # 1. LOGIN (STUDENT & FACULTY)
        if act == "LOGIN":
            sid = (payload.studentId or "").strip().upper()
            pwd = payload.password or ""
            if not sid or not pwd:
                return {"success": False, "message": "ID and Password are required."}

            user = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
            if not user:
                return {"success": False, "message": f'ID "{sid}" is not registered.'}

            if not verify_password(pwd, user.password_hash):
                return {"success": False, "message": "Invalid password. Please try again."}

            session_token = str(uuid.uuid4())
            db.add(AuthSession(
                token=session_token,
                student_id=user.student_id,
                otp_code=None,
                expires_at=datetime.utcnow() + timedelta(hours=12)
            ))
            db.commit()
            return {
                "success": True,
                "sessionToken": session_token,
                "user": {
                    "studentId": user.student_id,
                    "email": user.email,
                    "fullName": user.full_name,
                    "section": user.section,
                    "role": user.role
                }
            }

        # 2. STUDENT SELF-REGISTRATION
        elif act == "REGISTER_STUDENT":
            sid = (payload.studentId or "").strip().upper()
            name = (payload.fullName or "").strip()
            sec = (payload.section or "").strip().upper()
            email = (payload.email or "").strip().lower()
            pwd = payload.password or ""

            if not sid or not name or not sec or not pwd:
                return {"success": False, "message": "Student ID, Full Name, Section, and Password are required."}
            if len(pwd) < 6:
                return {"success": False, "message": "Password must be at least 6 characters long."}

            existing = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
            if existing:
                return {"success": False, "message": f'ID "{sid}" is already registered. Please sign in instead.'}

            new_student = RosterUser(
                student_id=sid,
                email=email,
                full_name=name,
                section=sec,
                role="STUDENT",
                password_hash=hash_password(pwd)
            )
            db.add(new_student)

            # Auto-enroll in any classes matching the student's default section
            matching_classes = db.query(CourseClass).all()
            for c in matching_classes:
                if (c.default_section or "").strip().upper() == sec:
                    db.add(Enrollment(class_id=c.class_id, student_id=sid))

            session_token = str(uuid.uuid4())
            db.add(AuthSession(
                token=session_token,
                student_id=sid,
                otp_code=None,
                expires_at=datetime.utcnow() + timedelta(hours=12)
            ))
            db.commit()

            return {
                "success": True,
                "sessionToken": session_token,
                "user": {
                    "studentId": new_student.student_id,
                    "email": new_student.email,
                    "fullName": new_student.full_name,
                    "section": new_student.section,
                    "role": new_student.role
                }
            }

        elif act == "CHANGE_PASSWORD":
            user = validate_token(db, payload.sessionToken)
            if not user:
                return {"success": False, "message": "Unauthorized session."}
            if not payload.newPassword or len(payload.newPassword) < 6:
                return {"success": False, "message": "New password must be at least 6 characters."}
            user.password_hash = hash_password(payload.newPassword)
            db.commit()
            return {"success": True, "message": "Password updated successfully."}

        elif act == "VALIDATE_SESSION":
            user = validate_token(db, payload.sessionToken)
            if not user:
                return {"valid": False}
            return {
                "valid": True,
                "user": {
                    "studentId": user.student_id,
                    "email": user.email,
                    "fullName": user.full_name,
                    "section": user.section,
                    "role": user.role
                }
            }

        # 3. STUDENT PORTAL RESULTS
        elif act == "GET_STUDENT_RESULTS":
            user = validate_token(db, payload.sessionToken)
            if not user:
                return {"success": False, "message": "Invalid session."}
            subs = db.query(Submission).filter(Submission.student_id.ilike(user.student_id)).order_by(Submission.timestamp.desc()).all()
            classes = {c.class_id: c for c in db.query(CourseClass).all()}
            results = []
            for s in subs:
                c_meta = classes.get(s.class_id)
                results.append({
                    "classId": s.class_id,
                    "subjectCode": c_meta.subject_code if c_meta else s.class_id,
                    "subjectTitle": c_meta.subject_title if c_meta else "Course Exam",
                    "section": s.section,
                    "set": s.test_set,
                    "rawScore": s.raw_score,
                    "totalPoints": s.total_points,
                    "percentage": f"{s.percentage}%",
                    "timestamp": s.timestamp.strftime("%Y-%m-%d %H:%M"),
                    "status": "PASSED" if s.is_passed else "FAILED"
                })
            return {
                "success": True,
                "student": {
                    "studentId": user.student_id,
                    "fullName": user.full_name,
                    "section": user.section
                },
                "results": results
            }

        # --- TEACHER / SYSTEM ADMIN ENDPOINTS BELOW ---
        user = validate_token(db, payload.sessionToken)
        if not user or user.role != "TEACHER":
            return {"success": False, "message": "Unauthorized teacher session."}

        # 4. SYSTEM ADMIN — FACULTY MANAGEMENT
        if act == "GET_FACULTY":
            teachers = db.query(RosterUser).filter_by(role="TEACHER").order_by(RosterUser.student_id.asc()).all()
            return {
                "success": True,
                "faculty": [
                    {
                        "facultyId": t.student_id,
                        "fullName": t.full_name,
                        "email": t.email,
                        "department": t.section
                    } for t in teachers
                ]
            }

        elif act == "REGISTER_FACULTY":
            fd = payload.facultyData or {}
            fid = (fd.get("facultyId") or "").strip().upper()
            fname = (fd.get("fullName") or "").strip()
            femail = (fd.get("email") or "").strip().lower()
            fdept = (fd.get("department") or "College of Engineering").strip()
            fpwd = fd.get("password") or ""

            if not fid or not fname or not fpwd:
                return {"success": False, "message": "Faculty ID, Full Name, and Password are required."}
            if len(fpwd) < 6:
                return {"success": False, "message": "Password must be at least 6 characters."}

            existing = db.query(RosterUser).filter(RosterUser.student_id.ilike(fid)).first()
            if existing:
                existing.full_name = fname
                existing.email = femail
                existing.section = fdept
                existing.role = "TEACHER"
                if fpwd:
                    existing.password_hash = hash_password(fpwd)
                db.commit()
                return {"success": True, "message": f"Faculty account {fid} updated."}

            db.add(RosterUser(
                student_id=fid,
                email=femail,
                full_name=fname,
                section=fdept,
                role="TEACHER",
                password_hash=hash_password(fpwd)
            ))
            db.commit()
            return {"success": True, "message": f"Faculty account {fid} registered."}

        elif act == "DELETE_FACULTY":
            target_id = (payload.facultyId or "").strip().upper()
            if target_id == "FACULTY-01" or target_id == user.student_id.upper():
                return {"success": False, "message": "Cannot delete the primary System Admin or your own active account."}
            db.query(RosterUser).filter(RosterUser.student_id.ilike(target_id)).delete()
            db.commit()
            return {"success": True}

        # 5. CLASSES MANAGEMENT
        elif act == "GET_CLASSES":
            if user.student_id.upper() == "FACULTY-01":
                classes = db.query(CourseClass).all()
            else:
                classes = db.query(CourseClass).filter_by(owner_teacher_id=user.student_id).all()
            res_list = []
            for c in classes:
                cnt = db.query(ExamItem).filter_by(class_id=c.class_id).count()
                res_list.append({
                    "classId": c.class_id,
                    "subjectCode": c.subject_code,
                    "subjectTitle": c.subject_title,
                    "defaultSection": c.default_section,
                    "section": c.default_section,
                    "passingPercentage": c.passing_percentage,
                    "totalItems": cnt or 50
                })
            return {"success": True, "classes": res_list}

        elif act == "SAVE_CLASS":
            cd = payload.classData or {}
            cid = cd.get("classId") or f"CLS-{uuid.uuid4().hex[:5].upper()}"
            existing = db.query(CourseClass).filter_by(class_id=cid).first()
            if existing:
                existing.subject_code = cd.get("subjectCode", existing.subject_code)
                existing.subject_title = cd.get("subjectTitle", existing.subject_title)
                existing.default_section = cd.get("defaultSection") or cd.get("section") or existing.default_section
                existing.passing_percentage = int(cd.get("passingPercentage", 70))
            else:
                db.add(CourseClass(
                    class_id=cid,
                    subject_code=cd.get("subjectCode", "NEW 101"),
                    subject_title=cd.get("subjectTitle", "Untitled Subject"),
                    default_section=cd.get("defaultSection") or cd.get("section") or "BS-ECE",
                    passing_percentage=int(cd.get("passingPercentage", 70)),
                    owner_teacher_id=user.student_id
                ))
            db.commit()
            return {"success": True, "classId": cid}

        elif act == "DELETE_CLASS":
            db.query(CourseClass).filter_by(class_id=payload.classId).delete()
            db.query(ExamItem).filter_by(class_id=payload.classId).delete()
            db.query(Enrollment).filter_by(class_id=payload.classId).delete()
            db.commit()
            return {"success": True}

        # 6. EXAM BUILDER & KEYS
        elif act == "GET_FULL_EXAM_CONFIG":
            items = db.query(ExamItem).filter_by(class_id=payload.classId).order_by(ExamItem.item_no.asc()).all()
            return {
                "success": True,
                "classId": payload.classId,
                "items": [
                    {
                        "itemNo": it.item_no,
                        "type": it.type,
                        "points": it.points,
                        "setA": it.set_a,
                        "setB": it.set_b
                    } for it in items
                ]
            }

        elif act == "SAVE_EXAM_CONFIG":
            db.query(ExamItem).filter_by(class_id=payload.classId).delete()
            for idx, it in enumerate(payload.items or []):
                db.add(ExamItem(
                    class_id=payload.classId,
                    item_no=idx + 1,
                    type=str(it.get("type", "MCQ")).upper(),
                    points=int(it.get("points", 1)),
                    set_a=str(it.get("setA", "A")).upper(),
                    set_b=str(it.get("setB", "A")).upper()
                ))
            db.commit()
            return {"success": True}

        # 7. ENROLLMENT & ROSTER
        elif act == "GET_CLASS_ENROLLMENTS":
            students = db.query(RosterUser).filter(RosterUser.role != "TEACHER").order_by(RosterUser.full_name.asc()).all()
            enrolled_ids = {
                e.student_id.upper()
                for e in db.query(Enrollment).filter_by(class_id=payload.classId).all()
            }
            enrolled, available = [], []
            for s in students:
                s_dict = {"studentId": s.student_id, "fullName": s.full_name, "section": s.section}
                if s.student_id.upper() in enrolled_ids:
                    enrolled.append(s_dict)
                else:
                    available.append(s_dict)
            return {"success": True, "enrolledStudents": enrolled, "availableStudents": available}

        elif act in ["ASSIGN_STUDENTS", "ASSIGN_STUDENTS_TO_CLASS"]:
            existing = {
                e.student_id.upper()
                for e in db.query(Enrollment).filter_by(class_id=payload.classId).all()
            }
            for sid in (payload.studentIds or []):
                if sid.upper() not in existing:
                    db.add(Enrollment(class_id=payload.classId, student_id=sid))
            db.commit()
            return {"success": True}

        elif act == "AUTO_ASSIGN_SECTION":
            sec = (payload.section or "").strip().upper()
            matching = db.query(RosterUser).filter(RosterUser.role != "TEACHER").all()
            existing = {
                e.student_id.upper()
                for e in db.query(Enrollment).filter_by(class_id=payload.classId).all()
            }
            for s in matching:
                if s.section.strip().upper() == sec and s.student_id.upper() not in existing:
                    db.add(Enrollment(class_id=payload.classId, student_id=s.student_id))
            db.commit()
            return {"success": True}

        elif act == "UNASSIGN_STUDENT":
            db.query(Enrollment).filter_by(class_id=payload.classId, student_id=payload.studentId).delete()
            db.commit()
            return {"success": True}

        elif act == "DELETE_STUDENT":
            target_sid = (payload.studentId or "").strip().upper()
            db.query(Enrollment).filter(Enrollment.student_id.ilike(target_sid)).delete()
            db.query(RosterUser).filter(RosterUser.student_id.ilike(target_sid), RosterUser.role == "STUDENT").delete()
            db.commit()
            return {"success": True}

        # 8. OPENCV OMR GRADING & SUBMISSION LEDGER
        elif act == "AI_VISION_GRADE":
            encoded = payload.base64Image.split(",")[1] if "," in payload.base64Image else payload.base64Image
            img_bytes = base64.b64decode(encoded)
            items = payload.items or []
            if not items and payload.classId:
                db_items = db.query(ExamItem).filter_by(class_id=payload.classId).order_by(ExamItem.item_no.asc()).all()
                items = [{"itemNo": i.item_no, "type": i.type, "points": i.points, "setA": i.set_a, "setB": i.set_b} for i in db_items]

            detected_answers, raw_score, total_points, breakdown, detected_qr_id, warped_b64 = grade_sheet_opencv(
                img_bytes, items, payload.testSet
            )

            cls_obj = db.query(CourseClass).filter_by(class_id=payload.classId).first()
            pass_pct = cls_obj.passing_percentage if cls_obj else 70
            percentage = round((raw_score / total_points) * 100, 2) if total_points > 0 else 0.0
            is_passed = percentage >= pass_pct

            return {
                "success": True,
                "studentId": payload.studentId or detected_qr_id or "",
                "warpedBase64": warped_b64,
                "answers": detected_answers,
                "rawScore": raw_score,
                "totalPoints": total_points,
                "percentage": percentage,
                "isPassed": is_passed,
                "status": "PASSED" if is_passed else "FAILED",
                "itemBreakdown": breakdown
            }

        elif act == "SCANNER_SUBMIT":
            sid = (payload.studentId or "").strip()
            st = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
            full_name = st.full_name if st else f"Student ({sid})"
            section = st.section if st else "Scanned Sheet"

            db_items = db.query(ExamItem).filter_by(class_id=payload.classId).order_by(ExamItem.item_no.asc()).all()
            raw_score, total_points = 0, 0
            ans_map = payload.answers or {}
            t_set = (payload.testSet or "A").upper()

            for it in db_items:
                total_points += it.points
                correct_key = (it.set_b if t_set == "B" else it.set_a).upper().strip()
                s_ans = str(ans_map.get(str(it.item_no), ans_map.get(it.item_no, ""))).upper().strip()
                if it.type == "TF":
                    if s_ans == "A": s_ans = "T"
                    elif s_ans == "B": s_ans = "F"
                if s_ans and (s_ans == correct_key or correct_key in ["*", "ALL"]):
                    raw_score += it.points

            cls_obj = db.query(CourseClass).filter_by(class_id=payload.classId).first()
            pass_pct = cls_obj.passing_percentage if cls_obj else 70
            pct = round((raw_score / total_points) * 100, 2) if total_points > 0 else 0.0
            is_passed = pct >= pass_pct

            existing_sub = db.query(Submission).filter_by(class_id=payload.classId, student_id=sid).first()
            if existing_sub:
                existing_sub.timestamp = datetime.utcnow()
                existing_sub.test_set = t_set
                existing_sub.raw_score = raw_score
                existing_sub.total_points = total_points
                existing_sub.percentage = pct
                existing_sub.is_passed = is_passed
                existing_sub.answers = ans_map
            else:
                db.add(Submission(
                    class_id=payload.classId,
                    student_id=sid,
                    full_name=full_name,
                    section=section,
                    test_set=t_set,
                    raw_score=raw_score,
                    total_points=total_points,
                    percentage=pct,
                    is_passed=is_passed,
                    answers=ans_map
                ))
            db.commit()
            return {
                "success": True,
                "fullName": full_name,
                "studentId": sid,
                "rawScore": raw_score,
                "totalPoints": total_points,
                "percentage": pct,
                "status": "PASSED" if is_passed else "FAILED"
            }

        elif act == "GET_SUBMISSIONS":
            subs = db.query(Submission).filter_by(class_id=payload.classId).order_by(Submission.timestamp.desc()).all()
            return {
                "success": True,
                "submissions": [
                    {
                        "fullName": s.full_name,
                        "studentId": s.student_id,
                        "testSet": s.test_set,
                        "set": s.test_set,
                        "rawScore": s.raw_score,
                        "totalPoints": s.total_points,
                        "percentage": f"{s.percentage}%",
                        "isPassed": s.is_passed,
                        "timestamp": s.timestamp.strftime("%Y-%m-%d %H:%M")
                    } for s in subs
                ]
            }

        return {"success": False, "message": f"Action '{act}' not supported."}
    except Exception as e:
        return {"success": False, "message": f"Backend error: {str(e)}"}