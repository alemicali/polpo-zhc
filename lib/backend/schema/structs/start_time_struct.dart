// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import '/flutter_flow/flutter_flow_util.dart';

class StartTimeStruct extends FFFirebaseStruct {
  StartTimeStruct({
    DateTime? startDate,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _startDate = startDate,
        super(firestoreUtilData);

  // "startDate" field.
  DateTime? _startDate;
  DateTime? get startDate => _startDate;
  set startDate(DateTime? val) => _startDate = val;

  bool hasStartDate() => _startDate != null;

  static StartTimeStruct fromMap(Map<String, dynamic> data) => StartTimeStruct(
        startDate: data['startDate'] as DateTime?,
      );

  static StartTimeStruct? maybeFromMap(dynamic data) => data is Map
      ? StartTimeStruct.fromMap(data.cast<String, dynamic>())
      : null;

  Map<String, dynamic> toMap() => {
        'startDate': _startDate,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'startDate': serializeParam(
          _startDate,
          ParamType.DateTime,
        ),
      }.withoutNulls;

  static StartTimeStruct fromSerializableMap(Map<String, dynamic> data) =>
      StartTimeStruct(
        startDate: deserializeParam(
          data['startDate'],
          ParamType.DateTime,
          false,
        ),
      );

  static StartTimeStruct fromAlgoliaData(Map<String, dynamic> data) =>
      StartTimeStruct(
        startDate: convertAlgoliaParam(
          data['startDate'],
          ParamType.DateTime,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'StartTimeStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    return other is StartTimeStruct && startDate == other.startDate;
  }

  @override
  int get hashCode => const ListEquality().hash([startDate]);
}

StartTimeStruct createStartTimeStruct({
  DateTime? startDate,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    StartTimeStruct(
      startDate: startDate,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

StartTimeStruct? updateStartTimeStruct(
  StartTimeStruct? startTime, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    startTime
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addStartTimeStructData(
  Map<String, dynamic> firestoreData,
  StartTimeStruct? startTime,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (startTime == null) {
    return;
  }
  if (startTime.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields =
      !forFieldValue && startTime.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final startTimeData = getStartTimeFirestoreData(startTime, forFieldValue);
  final nestedData = startTimeData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields = startTime.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getStartTimeFirestoreData(
  StartTimeStruct? startTime, [
  bool forFieldValue = false,
]) {
  if (startTime == null) {
    return {};
  }
  final firestoreData = mapToFirestore(startTime.toMap());

  // Add any Firestore field values
  startTime.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getStartTimeListFirestoreData(
  List<StartTimeStruct>? startTimes,
) =>
    startTimes?.map((e) => getStartTimeFirestoreData(e, true)).toList() ?? [];
